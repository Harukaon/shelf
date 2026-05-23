use crate::session::{FileEntry, SshTarget};
use crate::commands::ssh::ssh_exec;
use serde::Serialize;
use std::io::Read;
use std::path::Path;

const TEXT_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB cap on previewed text.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Serialize)]
pub struct TextFilePreview {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub is_binary: bool,
}

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

/// Read a text file for preview. Caps at TEXT_PREVIEW_MAX_BYTES and flags
/// binaries (a NUL byte anywhere in the sniff window). For SSH targets the
/// read is delegated to the remote via `head -c`.
#[tauri::command]
pub async fn read_text_file(path: String, ssh: Option<SshTarget>) -> Result<TextFilePreview, String> {
    if let Some(ssh_target) = ssh {
        return tauri::async_runtime::spawn_blocking(move || read_text_file_remote(&path, &ssh_target))
            .await
            .map_err(|e| format!("SSH read failed: {}", e))?;
    }
    tauri::async_runtime::spawn_blocking(move || read_text_file_local(&path))
        .await
        .map_err(|e| format!("Read failed: {}", e))?
}

fn read_text_file_local(path: &str) -> Result<TextFilePreview, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("Not a regular file: {}", path));
    }
    let metadata = std::fs::metadata(p).map_err(|e| format!("Stat failed: {}", e))?;
    let size = metadata.len();
    let truncated = size > TEXT_PREVIEW_MAX_BYTES;

    let mut file = std::fs::File::open(p).map_err(|e| format!("Open failed: {}", e))?;
    let mut buf: Vec<u8> = Vec::with_capacity(size.min(TEXT_PREVIEW_MAX_BYTES) as usize);
    file.take(TEXT_PREVIEW_MAX_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Read failed: {}", e))?;

    let is_binary = looks_binary(&buf);
    let content = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buf).into_owned()
    };
    Ok(TextFilePreview { content, size, truncated, is_binary })
}

fn read_text_file_remote(path: &str, ssh_target: &SshTarget) -> Result<TextFilePreview, String> {
    if path.contains('\'') {
        return Err("Path contains a single quote which is not supported".to_string());
    }
    // We ask for one extra byte so we can detect truncation.
    let cmd = format!(
        "wc -c < '{p}' 2>/dev/null; head -c {n} '{p}' 2>/dev/null",
        p = path,
        n = TEXT_PREVIEW_MAX_BYTES + 1
    );
    let raw = ssh_exec(ssh_target, &cmd)?;
    // First line is the size from wc -c; the rest is the head -c body.
    let (size_str, body) = match raw.split_once('\n') {
        Some((head, tail)) => (head.trim(), tail.to_string()),
        None => (raw.trim(), String::new()),
    };
    let size: u64 = size_str.parse().unwrap_or(0);

    let body_bytes = body.as_bytes();
    let truncated = body_bytes.len() as u64 > TEXT_PREVIEW_MAX_BYTES;
    let trimmed: String = if truncated {
        String::from_utf8_lossy(&body_bytes[..TEXT_PREVIEW_MAX_BYTES as usize]).into_owned()
    } else {
        body
    };
    let is_binary = looks_binary(trimmed.as_bytes());
    let content = if is_binary { String::new() } else { trimmed };
    Ok(TextFilePreview { content, size, truncated, is_binary })
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
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
