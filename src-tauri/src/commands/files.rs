use crate::session::FileEntry;

#[tauri::command]
pub fn list_files(path: String) -> Result<Vec<FileEntry>, String> {
    crate::session::scan_files(&path)
}
