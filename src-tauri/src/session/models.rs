use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub cwd: String,
    pub display_title: String,
    pub custom_title: Option<String>,
    pub ai_title: Option<String>,
    pub first_prompt: Option<String>,
    pub message_count: usize,
    pub started_at: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ShelfConfig {
    pub workspaces: Vec<Workspace>,
    #[serde(default = "default_shell")]
    pub shell: String,
    #[serde(default)]
    pub ext_term: Option<String>,
}

fn default_shell() -> String { "zsh".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileEntry>,
}
