use std::{
    collections::BTreeMap,
    ffi::OsString,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{async_runtime::RwLock, AppHandle, Runtime};

const PTY_READ_BUFFER_BYTES: usize = 64 * 1024;
const PTY_DEBUG: bool = true;

#[derive(Default)]
pub struct PtyState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<u32, Arc<PtySession>>>,
}

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    reader: Mutex<Box<dyn std::io::Read + Send>>,
    reader_closed: AtomicBool,
    child_exited: AtomicBool,
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
    encoding: Option<String>,
    handle_flow_control: Option<bool>,
    flow_control_pause: Option<String>,
    flow_control_resume: Option<String>,

    state: tauri::State<'_, PtyState>,
    _app_handle: AppHandle<R>,
) -> Result<u32, String> {
    let _ = encoding;
    let _ = handle_flow_control;
    let _ = flow_control_pause;
    let _ = flow_control_resume;

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

    let spawn_cwd = cwd.clone();
    let mut cmd = CommandBuilder::new(file);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(OsString::from(cwd));
    }
    cmd.env(OsString::from("TERM"), OsString::from(term_name.clone()));
    cmd.env(OsString::from("COLORTERM"), OsString::from("truecolor"));
    cmd.env(OsString::from("CLICOLOR"), OsString::from("1"));
    cmd.env(OsString::from("TERM_PROGRAM"), OsString::from("Shelf"));
    for (k, v) in env.iter() {
        cmd.env(OsString::from(k), OsString::from(v));
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_killer = child.clone_killer();
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
            reader_closed: AtomicBool::new(false),
            child_exited: AtomicBool::new(false),
        }),
    );
    if PTY_DEBUG {
        println!(
            "[PtyDebug] spawn pid={} term={} cols={} rows={} cwd={:?}",
            handler, term_name, cols, rows, spawn_cwd
        );
    }
    Ok(handler)
}

#[tauri::command]
pub async fn pty_write(
    pid: u32,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    if PTY_DEBUG {
        println!(
            "[PtyDebug] write pid={} bytes={} preview={}",
            pid,
            data.len(),
            data.chars().flat_map(|c| c.escape_default()).take(120).collect::<String>()
        );
    }
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
        let mut buf = vec![0u8; PTY_READ_BUFFER_BYTES];
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            Err(String::from("EOF"))
        } else {
            buf.truncate(n);
            drop(reader);
            Ok(buf)
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if PTY_DEBUG {
        match &result {
            Ok(buf) => {
                let text = String::from_utf8_lossy(buf);
                let preview: String = text.chars().flat_map(|c| c.escape_default()).take(160).collect();
                println!(
                    "[PtyDebug] read pid={} bytes={} preview={}",
                    pid,
                    buf.len(),
                    preview
                );
            }
            Err(err) => {
                println!("[PtyDebug] read pid={} error={}", pid, err);
            }
        }
    }
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
    if PTY_DEBUG {
        println!(
            "[PtyDebug] resize pid={} cols={} rows={} px={:?}x{:?}",
            pid, cols, rows, pixel_width, pixel_height
        );
    }
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
    let Some(session) = state.sessions.write().await.remove(&pid) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        session
            .child_killer
            .lock()
            .map_err(|e| e.to_string())?
            .kill()
            .map_err(|e| e.to_string())
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
