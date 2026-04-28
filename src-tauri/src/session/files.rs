use crate::session::models::FileEntry;
use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

pub fn scan_files(dir_path: &str) -> Result<Vec<FileEntry>, String> {
    let path = Path::new(dir_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("Directory not found: {}", dir_path));
    }

    // Collect all entries (flat, sorted)
    let mut flat: Vec<FileEntry> = Vec::new();

    for entry in WalkDir::new(dir_path)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.depth() == 0 {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && entry.depth() > 1 {
            continue;
        }

        let entry_path = entry.path().to_string_lossy().to_string();

        flat.push(FileEntry {
            name,
            path: entry_path,
            is_dir: entry.file_type().is_dir(),
            children: Vec::new(),
        });
    }

    flat.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    // Build tree in two passes:
    // Pass 1: create nodes indexed by path, attach children to parent nodes
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut nodes: Vec<FileEntry> = Vec::new();

    for entry in &flat {
        by_path.insert(entry.path.clone(), nodes.len());
        nodes.push(entry.clone());
    }

    for entry in &flat {
        let parent = Path::new(&entry.path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        if parent != dir_path {
            if let Some(&parent_idx) = by_path.get(&parent) {
                nodes[parent_idx].children.push(entry.clone());
            }
        }
    }

    // Pass 2: collect root entries from nodes (now with populated children)
    let mut root: Vec<FileEntry> = Vec::new();
    for entry in &flat {
        let parent = Path::new(&entry.path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        if parent == dir_path {
            if let Some(&idx) = by_path.get(&entry.path) {
                root.push(nodes[idx].clone());
            }
        }
    }

    Ok(root)
}
