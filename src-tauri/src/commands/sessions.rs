use crate::session::Session;

#[tauri::command]
pub fn scan_sessions(workspace_path: String) -> Result<Vec<Session>, String> {
    crate::session::scan_sessions(&workspace_path)
}

#[tauri::command]
pub fn rename_session(session_id: String, new_title: String) -> Result<(), String> {
    // TODO: P4 - implement rename by modifying JSONL custom-title entry
    let _ = (session_id, new_title);
    Ok(())
}
