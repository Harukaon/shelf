use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionProvider {
    Claude,
    Codex,
}

impl Default for SessionProvider {
    fn default() -> Self {
        SessionProvider::Claude
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SshTarget {
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

impl SshTarget {
    pub fn display_host(&self) -> String {
        let base = match (&self.user, &self.host) {
            (Some(u), h) => format!("{}@{}", u, h),
            (None, h) => h.clone(),
        };
        match self.port {
            Some(p) if p != 22 => format!("{}:{}", base, p),
            _ => base,
        }
    }
}

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
    pub provider: SessionProvider,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub provider: SessionProvider,
    #[serde(default)]
    pub ssh: Option<SshTarget>,
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

fn default_shell() -> String {
    "zsh".to_string()
}
fn default_lang() -> String {
    "en".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileEntry>,
}