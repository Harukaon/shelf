use super::*;

pub(super) struct LimitedTextOutput {
    text: String,
    used_chars: usize,
    max_chars: usize,
    pub(super) truncated: bool,
}

impl LimitedTextOutput {
    pub(super) fn new(max_chars: usize) -> Self {
        Self {
            text: String::new(),
            used_chars: 0,
            max_chars,
            truncated: false,
        }
    }

    pub(super) fn push_str(&mut self, value: &str) -> bool {
        if self.truncated {
            return false;
        }

        let remaining = self.max_chars.saturating_sub(self.used_chars);
        let value_chars = value.chars().count();
        if value_chars <= remaining {
            self.text.push_str(value);
            self.used_chars += value_chars;
            return true;
        }

        self.text.extend(value.chars().take(remaining));
        self.used_chars = self.max_chars;
        self.truncated = true;
        false
    }

    pub(super) fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub(super) fn into_string(mut self) -> String {
        if self.truncated {
            self.text.push_str(&format!(
                "\n---\n[truncated: tool result exceeded {} characters. Narrow the query or read a specific filePath range.]\n",
                self.max_chars
            ));
        }
        self.text
    }
}

fn shelf_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".shelf")
}

pub(super) fn ai_settings_path() -> PathBuf {
    shelf_dir().join("ai_settings.json")
}

fn ai_session_map_path() -> PathBuf {
    shelf_dir().join("ai_sessions.json")
}

fn config_path() -> PathBuf {
    shelf_dir().join("config.json")
}

pub(super) fn save_json<T: Serialize>(path: &Path, value: &T) -> AiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create config dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(value).map_err(|e| format!("Serialize: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Write {}: {}", path.display(), e))
}

pub(super) fn load_ai_settings() -> AiSettings {
    fs::read_to_string(ai_settings_path())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub(super) fn load_ai_map() -> AiSessionMap {
    fs::read_to_string(ai_session_map_path())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub(super) fn save_ai_map(map: &AiSessionMap) -> AiResult<()> {
    save_json(&ai_session_map_path(), map)
}

pub(super) fn load_config() -> ShelfConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or(ShelfConfig {
            workspaces: Vec::new(),
            shell: "zsh".to_string(),
            language: "en".to_string(),
            pinned: Vec::new(),
        })
}
