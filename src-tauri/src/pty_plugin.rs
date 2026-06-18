use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{async_runtime::RwLock, AppHandle, Runtime};

#[derive(Default)]
pub struct PtyState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<u32, Arc<PtySession>>>,
}

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// OS process id of the spawned child (NOT the session map key).
    /// On Unix, portable_pty runs `setsid()` in pre_exec, so this PID is
    /// also the process-group id / session id — killing `-child_pid` reaps
    /// the whole descendant tree (e.g. Claude Code's MCP grandchildren).
    child_pid: u32,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    reader: Mutex<Box<dyn std::io::Read + Send>>,
    reader_closed: AtomicBool,
    child_exited: AtomicBool,
}

/// Keys that should not be inherited from the login shell environment,
/// either because Shelf sets them explicitly or because they are
/// session-specific / display-specific.
const ENV_SKIP_KEYS: &[&str] = &[
    "PATH",
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SHLVL",
    "_",
    "PWD",
    "OLDPWD",
    "HOME",
    "LOGNAME",
    "USER",
    "SHELL",
];

/// Capture the full environment from a login shell so that variables
/// defined in `.zshrc` / `.zprofile` / `.bash_profile` (such as API keys
/// or custom tool configuration) are available to PTY child processes.
///
/// On macOS, GUI apps launched from Dock/Launchpad do **not** inherit
/// shell environment variables — only launchd's minimal environment is
/// available. This function bridges that gap.
///
/// The result is computed once and cached for the lifetime of the process.
fn login_shell_env() -> &'static BTreeMap<String, String> {
    static CACHE: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let shell_name = Path::new(&shell)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        // Use `-l` for login shell (loads .zprofile/.bash_profile),
        // `-c "env"` to dump the resulting environment.
        let args: Vec<&str> = if ["zsh", "bash"].contains(&shell_name.as_str()) {
            vec!["-l", "-c", "env"]
        } else {
            vec!["-c", "env"]
        };

        let output = match std::process::Command::new(&shell).args(&args).output() {
            Ok(o) if o.status.success() => o,
            _ => return BTreeMap::new(),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut env_map = BTreeMap::new();
        for line in stdout.lines() {
            if let Some((key, value)) = line.split_once('=') {
                if ENV_SKIP_KEYS.contains(&key) {
                    continue;
                }
                env_map.insert(key.to_string(), value.to_string());
            }
        }
        env_map
    })
}

fn is_path_env_key(key: &str) -> bool {
    if cfg!(target_os = "windows") {
        key.eq_ignore_ascii_case("PATH")
    } else {
        key == "PATH"
    }
}

fn push_path_if_dir(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        paths.push(path);
    }
}

fn collect_node_bin_dirs(root: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let bin = path.join("bin");
        if bin.join("node").is_file() {
            paths.push(bin);
        }
        collect_node_bin_dirs(&path, paths);
    }
}

fn inherited_path(env_overrides: &BTreeMap<String, String>) -> Option<OsString> {
    env_overrides
        .iter()
        .find(|(key, _)| is_path_env_key(key))
        .map(|(_, value)| OsString::from(value))
        .or_else(|| env::var_os("PATH"))
}

fn pty_spawn_path(file: &str, env_overrides: &BTreeMap<String, String>) -> Option<OsString> {
    let base_path = inherited_path(env_overrides);
    let mut paths = Vec::new();

    if let Some(parent) = Path::new(file)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        push_path_if_dir(&mut paths, parent.to_path_buf());
    }

    #[cfg(not(target_os = "windows"))]
    {
        for path in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            push_path_if_dir(&mut paths, PathBuf::from(path));
        }
    }

    if let Some(home) = dirs::home_dir() {
        for path in [
            home.join(".local/bin"),
            home.join("bin"),
            home.join(".cargo/bin"),
            home.join(".volta/bin"),
            home.join(".asdf/shims"),
            home.join(".bun/bin"),
            home.join(".npm-global/bin"),
            home.join("Library/pnpm"),
            home.join(".fnm/current/bin"),
        ] {
            push_path_if_dir(&mut paths, path);
        }
        collect_node_bin_dirs(&home.join(".nvm/versions/node"), &mut paths);
        collect_node_bin_dirs(&home.join(".fnm/node-versions"), &mut paths);
        collect_node_bin_dirs(
            &home.join("Library/Application Support/fnm/node-versions"),
            &mut paths,
        );
    }

    if let Some(base_path) = base_path {
        paths.extend(env::split_paths(&base_path));
    }

    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|item: &PathBuf| item == &path) {
            deduped.push(path);
        }
    }

    env::join_paths(deduped).ok()
}

async fn remove_session_if_done(
    pid: u32,
    session: &Arc<PtySession>,
    state: &tauri::State<'_, PtyState>,
) {
    if session.reader_closed.load(Ordering::Acquire) && session.child_exited.load(Ordering::Acquire)
    {
        let mut sessions = state.sessions.write().await;
        if sessions
            .get(&pid)
            .map_or(false, |current| Arc::ptr_eq(current, session))
        {
            sessions.remove(&pid);
        }
    }
}

#[tauri::command]
pub async fn pty_spawn<R: Runtime>(
    file: String,
    args: Vec<String>,
    term_name: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    env_remove: Option<Vec<String>>,

    state: tauri::State<'_, PtyState>,
    _app_handle: AppHandle<R>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let term_name = term_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "Terminal")
        .unwrap_or_else(|| "xterm-256color".to_string());

    let env_remove = env_remove.unwrap_or_default();
    let env_remove_keys: Vec<String> = env_remove
        .iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect();
    let remove_path = env_remove_keys.iter().any(|key| is_path_env_key(key));
    let path_env = if remove_path {
        None
    } else {
        pty_spawn_path(&file, &env)
    };

    let mut cmd = CommandBuilder::new(file);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(OsString::from(cwd));
    }
    for key in &env_remove_keys {
        cmd.env_remove(OsString::from(key));
    }
    cmd.env(OsString::from("TERM"), OsString::from(term_name));
    cmd.env(OsString::from("COLORTERM"), OsString::from("truecolor"));
    // EXPERIMENTAL (v0.2.11): masquerade as VS Code. Hypothesis: Claude Code's
    // TUI inspects TERM_PROGRAM to decide cursor-management strategy. With
    // TERM_PROGRAM=Shelf (unknown to it) it parks the real cursor at the
    // bottom bar after each redraw, so xterm renders the IME composition view
    // there instead of at the visible input box. If "vscode" makes Claude
    // Code keep the cursor in the input box, the IME placement bug goes away.
    // Revisit (or properly inherit a real terminal identifier) in v0.2.12.
    cmd.env(OsString::from("TERM_PROGRAM"), OsString::from("vscode"));
    // Inject login-shell environment (e.g. API keys from .zshrc/.zprofile)
    // so that GUI-launched Shelf can still access user-defined variables.
    // This is applied after Shelf's own TERM/COLORTERM/TERM_PROGRAM so
    // those always win, and before the frontend env overrides below.
    let login_env = login_shell_env();
    for (k, v) in login_env.iter() {
        if env_remove_keys.iter().any(|key| key == k) {
            continue;
        }
        cmd.env(OsString::from(k), OsString::from(v));
    }
    for (k, v) in env.iter() {
        if is_path_env_key(k) {
            continue;
        }
        cmd.env(OsString::from(k), OsString::from(v));
    }
    if let Some(path) = path_env {
        cmd.env(OsString::from("PATH"), path);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_killer = child.clone_killer();
    let child_pid = child.process_id().unwrap_or(0);
    let master = pair.master;
    drop(pair.slave);
    let handler = state.session_id.fetch_add(1, Ordering::Relaxed);

    state.sessions.write().await.insert(
        handler,
        Arc::new(PtySession {
            master: Mutex::new(master),
            child: Mutex::new(child),
            child_killer: Mutex::new(child_killer),
            writer: Mutex::new(writer),
            reader: Mutex::new(reader),
            child_pid,
            reader_closed: AtomicBool::new(false),
            child_exited: AtomicBool::new(false),
        }),
    );
    Ok(handler)
}

#[tauri::command]
pub async fn pty_write(
    pid: u32,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        session
            .writer
            .lock()
            .map_err(|e| e.to_string())?
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_read(pid: u32, state: tauri::State<'_, PtyState>) -> Result<Vec<u8>, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let read_session = session.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut reader = read_session.reader.lock().map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 4096];
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            Err(String::from("EOF"))
        } else {
            drop(reader);
            buf.truncate(n);
            Ok(buf)
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if matches!(result, Err(ref e) if e == "EOF") {
        session.reader_closed.store(true, Ordering::Release);
        remove_session_if_done(pid, &session, &state).await;
    }
    result
}

#[tauri::command]
pub async fn pty_resize(
    pid: u32,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    session
        .master
        .lock()
        .map_err(|e| e.to_string())?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: pixel_width.unwrap_or(0),
            pixel_height: pixel_height.unwrap_or(0),
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(pid: u32, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    // `pid` here is the frontend Pty handle (the session map key), NOT the
    // OS process id. The real OS pid lives on the session.
    let Some(session) = state.sessions.write().await.remove(&pid) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Kill the *whole process group*. portable_pty's Unix spawn runs
        // `setsid()` in pre_exec, so the child is a session leader: its PID
        // == PGID == SID, and every descendant (e.g. Claude Code's
        // chrome-devtools-mcp grandchildren) shares that group. Killing the
        // group is what prevents the orphaned MCP children that the old
        // single-PID SIGHUP (portable_pty's default kill) left behind.
        #[cfg(unix)]
        {
            if session.child_pid != 0 {
                let pgid = -(session.child_pid as i32);
                // SIGTERM first so the process can clean up its children
                // gracefully, then SIGKILL the group as a backstop.
                unsafe {
                    let _ = libc::kill(pgid, libc::SIGTERM);
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
                unsafe {
                    let _ = libc::kill(pgid, libc::SIGKILL);
                }
            }
        }
        // Final backstop: kill the direct child via portable_pty too. On
        // Unix this sends SIGHUP (harmless if the group kill already reaped
        // it); on Windows there is no process-group concept so this is the
        // primary path. Also covers the rare case where setsid didn't run.
        if let Ok(mut killer) = session.child_killer.lock() {
            let _ = killer.kill();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_exitstatus(pid: u32, state: tauri::State<'_, PtyState>) -> Result<u32, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let wait_session = session.clone();
    let exit_code = tauri::async_runtime::spawn_blocking(move || {
        wait_session
            .child
            .lock()
            .map_err(|e| e.to_string())?
            .wait()
            .map(|s| s.exit_code())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    session.child_exited.store(true, Ordering::Release);
    remove_session_if_done(pid, &session, &state).await;
    Ok(exit_code)
}
