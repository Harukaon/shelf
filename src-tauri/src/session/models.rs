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
    #[serde(default = "default_terminal_theme")]
    pub terminal_theme: TerminalThemeConfig,
    #[serde(default)]
    pub pinned: Vec<String>,
}

fn default_shell() -> String { "zsh".to_string() }
fn default_lang() -> String { "en".to_string() }
fn default_terminal_theme() -> TerminalThemeConfig { TerminalThemeConfig::default() }

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalThemeConfig {
    #[serde(default = "default_terminal_theme_preset")]
    pub preset: String,
    #[serde(default = "default_terminal_background")]
    pub background: String,
    #[serde(default = "default_terminal_foreground")]
    pub foreground: String,
    #[serde(default = "default_terminal_cursor")]
    pub cursor: String,
    #[serde(default = "default_terminal_selection")]
    pub selection_background: String,
}

impl Default for TerminalThemeConfig {
    fn default() -> Self {
        Self {
            preset: default_terminal_theme_preset(),
            background: default_terminal_background(),
            foreground: default_terminal_foreground(),
            cursor: default_terminal_cursor(),
            selection_background: default_terminal_selection(),
        }
    }
}

fn default_terminal_theme_preset() -> String { "shelf_comfort".to_string() }
fn default_terminal_background() -> String { "#282C34".to_string() }
fn default_terminal_foreground() -> String { "#E0E0E1".to_string() }
fn default_terminal_cursor() -> String { "#F3F3F4".to_string() }
fn default_terminal_selection() -> String { "#3A4250".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileEntry>,
}
