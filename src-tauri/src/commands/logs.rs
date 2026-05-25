use tauri::{AppHandle, Manager};

/// Return the absolute path to Shelf's log directory.
///
/// `tauri-plugin-log` writes to `app_log_dir`, which on macOS is
/// `~/Library/Logs/com.shelf.app/` and on Windows
/// `%LOCALAPPDATA%\com.shelf.app\logs\`. The frontend's Settings panel
/// surfaces this path so users can grab the log file when reporting bugs.
#[tauri::command]
pub fn get_log_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
