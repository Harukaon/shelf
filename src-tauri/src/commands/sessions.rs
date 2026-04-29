use crate::session::Session;
use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub fn scan_sessions(workspace_path: String) -> Result<Vec<Session>, String> {
    crate::session::scan_sessions(&workspace_path)
}

#[tauri::command]
pub fn create_session(workspace_path: String) -> Result<serde_json::Value, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let projects_dir = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".claude")
        .join("projects");
    let sanitized = workspace_path.replace('/', "-");
    let project_dir = projects_dir.join(&sanitized);
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Cannot create project dir: {}", e))?;

    let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
    let entry = serde_json::json!({
        "type": "user",
        "uuid": uuid::Uuid::new_v4().to_string(),
        "sessionId": session_id,
        "cwd": workspace_path,
        "timestamp": now,
        "version": "",
        "userType": "external",
        "entrypoint": "cli",
        "message": { "role": "user", "content": "" },
    });
    let line = serde_json::to_string(&entry)
        .map_err(|e| format!("Serialize: {}", e))?;
    fs::write(&jsonl_path, line + "\n")
        .map_err(|e| format!("Write: {}", e))?;

    Ok(serde_json::json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn rename_session(session_id: String, new_title: String) -> Result<(), String> {
    println!("[Rust] rename_session: id={}, title={}", session_id, new_title);
    let projects_dir = if let Some(home) = dirs::home_dir() {
        home.join(".claude").join("projects")
    } else {
        return Err("Cannot find home directory".to_string());
    };
    println!("[Rust] projects_dir: {:?}", projects_dir);

    let entries = fs::read_dir(&projects_dir)
        .map_err(|e| format!("Cannot read projects dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let project_dir = entry.path();
        if !project_dir.is_dir() { continue; }
        let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
        if jsonl_path.exists() {
            println!("[Rust] found jsonl: {:?}", jsonl_path);
            let entry = serde_json::json!({
                "type": "custom-title",
                "customTitle": new_title,
                "sessionId": session_id,
            });
            let line = serde_json::to_string(&entry)
                .map_err(|e| format!("Serialize error: {}", e))?;
            let mut content = fs::read_to_string(&jsonl_path)
                .unwrap_or_default();
            if !content.ends_with('\n') { content.push('\n'); }
            content.push_str(&line);
            content.push('\n');
            fs::write(&jsonl_path, content)
                .map_err(|e| format!("Write error: {}", e))?;
            println!("[Rust] rename_session: written OK");
            return Ok(());
        }
    }
    Err(format!("Session file not found for id: {}", session_id))
}

#[tauri::command]
pub fn delete_session(session_id: String) -> Result<(), String> {
    let projects_dir = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".claude")
        .join("projects");

    let entries = fs::read_dir(&projects_dir)
        .map_err(|e| format!("Cannot read projects dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let project_dir = entry.path();
        if !project_dir.is_dir() { continue; }
        let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
        if jsonl_path.exists() {
            trash::delete(&jsonl_path)
                .map_err(|e| format!("Trash error: {}", e))?;
            println!("[Rust] delete_session: moved to trash {:?}", jsonl_path);
            return Ok(());
        }
    }
    Err(format!("Session file not found for id: {}", session_id))
}
