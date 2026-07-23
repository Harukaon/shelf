use crate::session::{SessionProvider, ShelfConfig, SshTarget, Workspace};
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".shelf")
        .join("config.json")
}

fn app_state_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".shelf")
        .join("state.json")
}

pub(crate) fn load_config() -> ShelfConfig {
    let path = config_path();
    if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        ShelfConfig::default()
    }
}

pub(crate) fn save_config(config: &ShelfConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let content =
        serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn add_workspace(path: String, provider: Option<SessionProvider>, ssh: Option<SshTarget>) -> Result<Workspace, String> {
    let provider = provider.unwrap_or_default();
    let name = if let Some(ref ssh_target) = ssh {
        ssh_target.display_host()
    } else {
        std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone())
    };

    let workspace = Workspace {
        name: name.clone(),
        path: path.clone(),
        provider,
        ssh: ssh.clone(),
    };

    let mut config = load_config();

    // Uniqueness is by (path, provider, ssh-host?). Two workspaces pointing
    // at the same remote path but with different providers (Claude, Codex, or pi)
    // are intentionally allowed; same provider on the same SSH host + path
    // is a duplicate.
    let already_exists = if let Some(ref ssh_target) = ssh {
        config.workspaces.iter().any(|w| {
            w.path == path
                && w.provider == provider
                && w.ssh.as_ref().map_or(false, |s| s.host == ssh_target.host)
        })
    } else {
        config.workspaces.iter().any(|w| w.path == path && w.provider == provider && w.ssh.is_none())
    };

    if already_exists {
        return Err("Workspace already exists".to_string());
    }

    config.workspaces.push(workspace.clone());
    save_config(&config)?;

    Ok(workspace)
}

#[tauri::command]
pub fn remove_workspace(path: String, provider: Option<SessionProvider>, ssh: Option<SshTarget>) -> Result<(), String> {
    let provider = provider.unwrap_or_default();
    let mut config = load_config();
    if let Some(ref ssh_target) = ssh {
        config.workspaces.retain(|w| {
            !(w.path == path
                && w.provider == provider
                && w.ssh.as_ref().map_or(false, |s| s.host == ssh_target.host))
        });
    } else {
        config.workspaces.retain(|w| !(w.path == path && w.provider == provider && w.ssh.is_none()));
    }
    save_config(&config)?;
    Ok(())
}

#[tauri::command]
pub fn list_workspaces() -> Result<Vec<serde_json::Value>, String> {
    let config = load_config();
    let items: Vec<serde_json::Value> = config
        .workspaces
        .into_iter()
        .map(|w| {
            let mut val = serde_json::json!({
                "name": w.name,
                "path": w.path,
                "provider": w.provider,
                "session_count": 0,
            });
            if let Some(ssh) = w.ssh {
                val["ssh"] = serde_json::json!({
                    "host": ssh.host,
                    "user": ssh.user,
                    "port": ssh.port,
                    "identityFile": ssh.identity_file,
                });
            }
            val
        })
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn get_settings() -> Result<serde_json::Value, String> {
    let config = load_config();
    Ok(serde_json::json!({
        "shell": config.shell,
        "language": config.language,
        "pinned": config.pinned,
        "session_titles": config.session_titles,
        "claudeArgs": config.claude_args,
        "codexArgs": config.codex_args,
        "piArgs": config.pi_args,
    }))
}

#[tauri::command]
pub fn save_settings(settings: serde_json::Value) -> Result<(), String> {
    let mut config = load_config();
    let payload = if settings.get("settings").is_some() {
        &settings["settings"]
    } else {
        &settings
    };
    if let Some(shell) = payload.get("shell").and_then(|s| s.as_str()) {
        config.shell = shell.to_string();
    }
    if let Some(lang) = payload.get("language").and_then(|s| s.as_str()) {
        config.language = lang.to_string();
    }
    if let Some(args) = payload
        .get("claudeArgs")
        .or_else(|| payload.get("claude_args"))
        .and_then(|value| value.as_array())
    {
        config.claude_args = args
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
    }
    if let Some(args) = payload
        .get("codexArgs")
        .or_else(|| payload.get("codex_args"))
        .and_then(|value| value.as_array())
    {
        config.codex_args = args
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
    }
    if let Some(args) = payload
        .get("piArgs")
        .or_else(|| payload.get("pi_args"))
        .and_then(|value| value.as_array())
    {
        config.pi_args = args
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
    }
    save_config(&config)
}

#[tauri::command]
pub fn detect_terminals() -> Result<serde_json::Value, String> {
    let mut shells: Vec<String> = vec![];

    #[cfg(target_os = "windows")]
    {
        let creation_no_window = CREATE_NO_WINDOW;
        for shell_bin in &["powershell", "cmd", "pwsh"] {
            if std::process::Command::new("where")
                .arg(shell_bin)
                .creation_flags(creation_no_window)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                shells.push(shell_bin.to_string());
            }
        }
        if shells.is_empty() {
            shells.push("powershell".to_string());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for shell_bin in &["zsh", "bash", "fish"] {
            if std::process::Command::new("which")
                .arg(shell_bin)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                shells.push(shell_bin.to_string());
            }
        }
        if shells.is_empty() {
            shells.push("zsh".to_string());
        }
    }

    Ok(serde_json::json!({ "shells": shells }))
}

#[tauri::command]
pub fn pin_session(session_id: String) -> Result<(), String> {
    let mut config = load_config();
    if !config.pinned.contains(&session_id) {
        config.pinned.push(session_id);
    }
    save_config(&config)
}

#[tauri::command]
pub fn unpin_session(session_id: String) -> Result<(), String> {
    let mut config = load_config();
    config.pinned.retain(|id| id != &session_id);
    save_config(&config)
}

#[tauri::command]
pub fn get_pinned() -> Result<Vec<String>, String> {
    let config = load_config();
    Ok(config.pinned)
}

#[tauri::command]
pub fn get_app_state() -> Result<serde_json::Value, String> {
    let path = app_state_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Read app state: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Parse app state: {}", e))
}

#[tauri::command]
pub fn save_app_state(state: serde_json::Value) -> Result<(), String> {
    let path = app_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create app state dir: {}", e))?;
    }
    let content =
        serde_json::to_string_pretty(&state).map_err(|e| format!("Serialize app state: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Write app state: {}", e))
}

#[tauri::command]
pub fn exit_app() {
    std::process::exit(0);
}

#[tauri::command]
pub fn find_claude() -> Result<String, String> {
    for path in claude_candidates() {
        if is_executable_file(&path) {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(path) = find_command_on_windows("claude") {
            return Ok(path);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if let Some(path) = find_claude_with_shell(shell) {
                return Ok(path);
            }
        }
    }

    Err("claude not found".to_string())
}

#[tauri::command]
pub fn find_codex() -> Result<String, String> {
    find_cli("codex", codex_candidates())
}

#[tauri::command]
pub fn find_pi() -> Result<String, String> {
    find_cli("pi", pi_candidates())
}

fn find_cli(command_name: &str, candidates: Vec<PathBuf>) -> Result<String, String> {
    for path in candidates {
        if is_executable_file(&path) {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(path) = find_command_on_windows(command_name) {
            return Ok(path);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if let Some(path) = find_command_with_shell(shell, command_name) {
                return Ok(path);
            }
        }
    }

    Err(format!("{} not found", command_name))
}

fn codex_candidates() -> Vec<PathBuf> {
    cli_candidates("codex")
}
fn pi_candidates() -> Vec<PathBuf> {
    cli_candidates("pi")
}
fn claude_candidates() -> Vec<PathBuf> {
    cli_candidates("claude")
}

/// Build the list of common install locations to probe for a Node-based CLI
/// (`claude`, `codex`, `pi`). The list mirrors how popular package managers / Node
/// version managers lay out global binaries on each platform; missing entries
/// fall through to `find_command_on_windows` (Windows) or
/// `find_command_with_shell` (Unix) which walks the live PATH.
fn cli_candidates(bin: &str) -> Vec<PathBuf> {
    let mut candidates = vec![];

    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from(format!(
            "C:/Program Files/nodejs/{bin}.cmd"
        )));
        if let Some(home) = dirs::home_dir() {
            candidates.extend([
                home.join(format!("AppData/Roaming/npm/{bin}.cmd")),
                home.join(format!(".local/bin/{bin}.exe")),
                home.join(format!("scoop/shims/{bin}.cmd")),
                home.join(format!("AppData/Local/pnpm/{bin}.cmd")),
                home.join(format!("AppData/Local/Volta/bin/{bin}.exe")),
                home.join(format!("AppData/Local/Volta/bin/{bin}.cmd")),
            ]);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.extend([
            PathBuf::from(format!("/opt/homebrew/bin/{bin}")),
            PathBuf::from(format!("/usr/local/bin/{bin}")),
            PathBuf::from(format!("/usr/bin/{bin}")),
            PathBuf::from(format!("/home/linuxbrew/.linuxbrew/bin/{bin}")),
        ]);
    }

    if let Some(home) = dirs::home_dir() {
        candidates.extend([
            home.join(format!(".local/bin/{bin}")),
            home.join(format!("bin/{bin}")),
            home.join(format!(".volta/bin/{bin}")),
            home.join(format!(".asdf/shims/{bin}")),
            home.join(format!(".bun/bin/{bin}")),
            home.join(format!(".npm-global/bin/{bin}")),
            home.join(format!(".local/share/pnpm/{bin}")),
            home.join(format!(".local/share/mise/shims/{bin}")),
        ]);

        #[cfg(target_os = "macos")]
        candidates.push(home.join(format!("Library/pnpm/{bin}")));

        candidates.extend(find_versioned_bin_named(
            &home.join(".nvm/versions/node"),
            bin,
        ));
        candidates.extend(find_versioned_bin_named(
            &home.join(".fnm/node-versions"),
            bin,
        ));

        #[cfg(target_os = "macos")]
        candidates.extend(find_versioned_bin_named(
            &home.join("Library/Application Support/fnm/node-versions"),
            bin,
        ));

        #[cfg(target_os = "windows")]
        {
            if let Some(local) = dirs::data_local_dir() {
                candidates.extend(find_versioned_bin_named(
                    &local.join("fnm/node-versions"),
                    bin,
                ));
            }
            // nvm-windows: %USERPROFILE%/AppData/Roaming/nvm/v<ver>/
            candidates.extend(find_versioned_bin_named(
                &home.join("AppData/Roaming/nvm"),
                bin,
            ));
        }
    }

    candidates
}

fn find_versioned_bin_named(root: &Path, bin_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return candidates;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        candidates.push(path.join("bin").join(bin_name));
        #[cfg(target_os = "windows")]
        {
            candidates.push(path.join("bin").join(format!("{}.cmd", bin_name)));
            candidates.push(path.join("Scripts").join(format!("{}.exe", bin_name)));
        }
        candidates.extend(find_versioned_bin_named(&path, bin_name));
    }

    candidates
}
#[cfg(target_os = "windows")]
fn find_command_on_windows(command_name: &str) -> Option<String> {
    // Resolve `command` via PowerShell's `Get-Command -All`, then prefer
    // directly-executable wrappers (.cmd / .exe / .bat) over .ps1. portable-pty
    // can't CreateProcess a .ps1 directly, and even when invoked through a
    // shell a quoted .ps1 path is parsed by PowerShell as a string literal
    // (needs the `&` call operator) — both failure modes we want to avoid.
    // `[Console]::OutputEncoding = UTF8` keeps non-ASCII paths (CJK usernames,
    // etc.) intact across the stdio pipe.
    let script = format!(
        r#"$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$all = Get-Command {name} -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
$exe = $all | Where-Object {{ $_ -match '\.(cmd|exe|bat)$' }} | Select-Object -First 1
if ($exe) {{ $exe }} elseif ($all) {{ $all | Select-Object -First 1 }}"#,
        name = command_name
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script.as_str()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(target_os = "windows"))]
fn find_claude_with_shell(shell: &str) -> Option<String> {
    let command = r#"
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
        [ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" >/dev/null 2>&1
        command -v claude
    "#;
    let output = std::process::Command::new(shell)
        .args(["-l", "-c", command])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(target_os = "windows"))]
fn find_command_with_shell(shell: &str, command_name: &str) -> Option<String> {
    let command = format!(
        r#"
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
        [ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" >/dev/null 2>&1
        command -v {}
    "#,
        command_name,
    );
    let output = std::process::Command::new(shell)
        .args(["-l", "-c", command.as_str()])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}
