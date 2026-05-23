use crate::session::{FileEntry, SshTarget};
use crate::commands::ssh::ssh_exec;
use std::path::Path;

#[tauri::command]
pub async fn list_files(path: String, ssh: Option<SshTarget>) -> Result<Vec<FileEntry>, String> {
    if let Some(ssh_target) = ssh {
        return tauri::async_runtime::spawn_blocking(move || list_files_remote(&path, &ssh_target))
            .await
            .map_err(|e| format!("SSH list files failed: {}", e))?;
    }
    tauri::async_runtime::spawn_blocking(move || crate::session::scan_files(&path))
        .await
        .map_err(|e| format!("List files failed: {}", e))?
}

fn list_files_remote(dir_path: &str, ssh_target: &SshTarget) -> Result<Vec<FileEntry>, String> {
    // Use stat on the remote host for structured output
    let cmd = format!(
        "stat -f '%Sp %N' {} 2>/dev/null || ls -la {} 2>/dev/null",
        dir_path, dir_path
    );
    // Simpler: use ls -1p which appends / to directories
    let cmd = format!("ls -1p {}", dir_path);
    let output = ssh_exec(ssh_target, &cmd)?;
    if output.is_empty() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for line in output.lines() {
        let name = line.trim_end_matches('/');
        if name.is_empty() || name == "." || name == ".." || name.starts_with('.') {
            continue;
        }
        let is_dir = line.ends_with('/');
        let full_path = if dir_path.ends_with('/') {
            format!("{}{}", dir_path, name)
        } else {
            format!("{}/{}", dir_path, name)
        };
        entries.push(FileEntry {
            name: name.to_string(),
            path: full_path,
            is_dir,
            children: Vec::new(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("File not found".to_string());
    }
    trash::delete(p).map_err(|e| format!("Trash error: {}", e))
}
