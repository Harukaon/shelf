use crate::session::FileEntry;
use std::path::Path;

#[tauri::command]
pub fn list_files(path: String) -> Result<Vec<FileEntry>, String> {
    crate::session::scan_files(&path)
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("File not found".to_string());
    }
    trash::delete(p).map_err(|e| format!("Trash error: {}", e))
}
