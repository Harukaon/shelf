use crate::session::{Workspace, ShelfConfig};
use std::fs;
use std::path::PathBuf;

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".shelf")
        .join("config.json")
}

fn load_config() -> ShelfConfig {
    let path = config_path();
    if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(ShelfConfig {
            workspaces: Vec::new(),
            shell: "zsh".to_string(),
            language: "en".to_string(),
            pinned: Vec::new(),
        })
    } else {
        ShelfConfig {
            workspaces: Vec::new(),
            shell: "zsh".to_string(),
            language: "en".to_string(),
            pinned: Vec::new(),
        }
    }
}

fn save_config(config: &ShelfConfig) -> Result<(), String> {
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
pub fn add_workspace(path: String) -> Result<Workspace, String> {
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let workspace = Workspace {
        name: name.clone(),
        path: path.clone(),
    };

    let mut config = load_config();

    if config.workspaces.iter().any(|w| w.path == path) {
        return Err("Workspace already exists".to_string());
    }

    config.workspaces.push(workspace.clone());
    save_config(&config)?;

    Ok(workspace)
}

#[tauri::command]
pub fn remove_workspace(path: String) -> Result<(), String> {
    let mut config = load_config();
    config.workspaces.retain(|w| w.path != path);
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
            serde_json::json!({
                "name": w.name,
                "path": w.path,
                "session_count": 0,
            })
        })
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn get_settings() -> Result<serde_json::Value, String> {
    let config = load_config();
    Ok(serde_json::json!({ "shell": config.shell, "language": config.language, "pinned": config.pinned }))
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
    save_config(&config)
}

#[tauri::command]
pub fn detect_terminals() -> Result<serde_json::Value, String> {
    let mut shells: Vec<String> = vec![];
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
pub fn exit_app() {
    std::process::exit(0);
}
