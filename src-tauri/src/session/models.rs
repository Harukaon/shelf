use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionProvider {
    Claude,
    Codex,
    Pi,
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
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default = "default_shell")]
    pub shell: String,
    #[serde(default = "default_lang")]
    pub language: String,
    #[serde(default)]
    pub pinned: Vec<String>,
    #[serde(default)]
    pub session_titles: BTreeMap<String, String>,
    #[serde(default)]
    pub claude_args: Vec<String>,
    #[serde(default)]
    pub codex_args: Vec<String>,
    #[serde(default)]
    pub pi_args: Vec<String>,
}

impl Default for ShelfConfig {
    fn default() -> Self {
        Self {
            workspaces: Vec::new(),
            shell: default_shell(),
            language: default_lang(),
            pinned: Vec::new(),
            session_titles: BTreeMap::new(),
            claude_args: Vec::new(),
            codex_args: Vec::new(),
            pi_args: Vec::new(),
        }
    }
}

fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        "powershell".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "zsh".to_string()
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_config_defaults_cli_args() {
        let config: ShelfConfig = serde_json::from_str(
            r#"{"workspaces":[],"shell":"zsh","language":"en","pinned":[],"session_titles":{}}"#,
        )
        .expect("legacy config should remain readable");

        assert!(config.claude_args.is_empty());
        assert!(config.codex_args.is_empty());
        assert!(config.pi_args.is_empty());
    }

    #[test]
    fn cli_args_round_trip_as_argv() {
        let mut config = ShelfConfig::default();
        config.claude_args = vec![
            "--dangerously-skip-permissions".to_string(),
            "--settings".to_string(),
            "/Users/username/My Settings/claude.json".to_string(),
        ];
        config.codex_args = vec!["--profile".to_string(), "work".to_string()];
        config.pi_args = vec![
            "--model".to_string(),
            "anthropic/claude-sonnet-4".to_string(),
        ];

        let encoded = serde_json::to_string(&config).expect("config should serialize");
        let decoded: ShelfConfig = serde_json::from_str(&encoded).expect("config should deserialize");

        assert_eq!(decoded.claude_args, config.claude_args);
        assert_eq!(decoded.codex_args, config.codex_args);
        assert_eq!(decoded.pi_args, config.pi_args);
    }
}
