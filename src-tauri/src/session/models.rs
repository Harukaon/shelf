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
    pub updated_at: String,
    pub file_path: String,
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
    #[serde(default = "default_lang")]
    pub language: String,
    #[serde(default)]
    pub pinned: Vec<String>,
}

fn default_shell() -> String { "zsh".to_string() }
fn default_lang() -> String { "en".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileEntry>,
}
