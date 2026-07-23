use crate::session::{Session, SessionProvider};
use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub fn scan_pi_sessions(
    workspace_path: &str,
    session_dir_override: Option<&str>,
) -> Result<Vec<Session>, String> {
    let session_dirs = pi_session_dirs(workspace_path, session_dir_override);
    let mut sessions = Vec::new();
    let mut seen_files = HashSet::new();

    for session_dir in session_dirs {
        if !session_dir.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&session_dir).map_err(|e| {
            format!(
                "Failed to read pi sessions dir '{}': {}",
                session_dir.display(),
                e
            )
        })?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let path_key = path.to_string_lossy().to_string();
            if !seen_files.insert(path_key) {
                continue;
            }
            let Ok(Some(session)) = parse_pi_session_file(&path) else {
                continue;
            };
            if paths_equal(&session.cwd, workspace_path) {
                sessions.push(session);
            }
        }
    }

    sessions.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.started_at.cmp(&a.started_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(sessions)
}

pub fn parse_pi_session_content(
    content: &str,
    file_path: impl Into<String>,
) -> Result<Option<Session>, String> {
    let mut values = content.lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() {
            None
        } else {
            serde_json::from_str::<Value>(line).ok()
        }
    });

    let Some(header) = values.next() else {
        return Ok(None);
    };
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Ok(None);
    }

    let session_id = header
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if session_id.is_empty() {
        return Ok(None);
    }

    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let started_at = header
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let version = header
        .get("version")
        .map(|value| {
            value
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| value.to_string())
        })
        .unwrap_or_default();

    let mut custom_title: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut message_count = 0usize;
    let mut updated_at = parse_rfc3339(&started_at);

    for value in values {
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "session_info" => {
                custom_title = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(ToString::to_string);
            }
            "message" => {
                message_count += 1;
                let Some(message) = value.get("message") else {
                    continue;
                };
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if role != "user" && role != "assistant" {
                    continue;
                }

                if role == "user" && first_prompt.is_none() {
                    let text = extract_message_text(message);
                    if !text.trim().is_empty() {
                        first_prompt = Some(preview_text(&text, 80));
                    }
                }

                let activity = message
                    .get("timestamp")
                    .and_then(Value::as_i64)
                    .and_then(|millis| Utc.timestamp_millis_opt(millis).single())
                    .or_else(|| {
                        value
                            .get("timestamp")
                            .and_then(Value::as_str)
                            .and_then(parse_rfc3339)
                    });
                if let Some(activity) = activity {
                    updated_at = Some(updated_at.map_or(activity, |current| current.max(activity)));
                }
            }
            _ => {}
        }
    }

    let display_title = custom_title
        .clone()
        .or_else(|| first_prompt.clone())
        .unwrap_or_else(|| "(untitled)".to_string());
    let updated_at = updated_at
        .map(|timestamp| timestamp.to_rfc3339())
        .unwrap_or_else(|| started_at.clone());

    Ok(Some(Session {
        id: session_id,
        cwd,
        display_title,
        custom_title,
        ai_title: None,
        first_prompt,
        message_count,
        started_at,
        updated_at,
        file_path: file_path.into(),
        version,
        provider: SessionProvider::Pi,
    }))
}

pub fn encode_pi_cwd(path: &str) -> String {
    let stripped = path
        .strip_prefix('/')
        .or_else(|| path.strip_prefix('\\'))
        .unwrap_or(path);
    let safe_path: String = stripped
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\\' || ch == ':' {
                '-'
            } else {
                ch
            }
        })
        .collect();
    format!("--{}--", safe_path)
}

fn parse_pi_session_file(path: &Path) -> Result<Option<Session>, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read pi session '{}': {}", path.display(), e))?;
    parse_pi_session_content(&content, path.to_string_lossy().to_string())
}

fn pi_session_dirs(workspace_path: &str, session_dir_override: Option<&str>) -> Vec<PathBuf> {
    if let Some(dir) = effective_custom_session_dir(workspace_path, session_dir_override) {
        return vec![dir];
    }

    let sessions_root = pi_agent_dir(workspace_path).join("sessions");
    let mut workspace_candidates = vec![absolute_path(workspace_path)];
    if let Ok(canonical) = fs::canonicalize(workspace_path) {
        workspace_candidates.push(canonical);
    }
    workspace_candidates.sort();
    workspace_candidates.dedup();
    workspace_candidates
        .into_iter()
        .map(|path| sessions_root.join(encode_pi_cwd(&path.to_string_lossy())))
        .collect()
}

fn effective_custom_session_dir(
    workspace_path: &str,
    session_dir_override: Option<&str>,
) -> Option<PathBuf> {
    let configured = session_dir_override
        .map(ToString::to_string)
        .or_else(|| std::env::var("PI_CODING_AGENT_SESSION_DIR").ok())
        .or_else(|| read_project_session_dir(workspace_path))
        .or_else(|| read_global_session_dir(workspace_path))?;
    let expanded = expand_tilde(configured.trim());
    if expanded.as_os_str().is_empty() {
        return None;
    }
    if expanded.is_absolute() {
        Some(expanded)
    } else {
        Some(absolute_path(workspace_path).join(expanded))
    }
}

fn read_project_session_dir(workspace_path: &str) -> Option<String> {
    read_session_dir_setting(
        &absolute_path(workspace_path)
            .join(".pi")
            .join("settings.json"),
    )
}

fn read_global_session_dir(workspace_path: &str) -> Option<String> {
    read_session_dir_setting(&pi_agent_dir(workspace_path).join("settings.json"))
}

fn read_session_dir_setting(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&content)
        .ok()?
        .get("sessionDir")?
        .as_str()
        .map(ToString::to_string)
}

fn pi_agent_dir(workspace_path: &str) -> PathBuf {
    if let Ok(path) = std::env::var("PI_CODING_AGENT_DIR") {
        let expanded = expand_tilde(path.trim());
        if !expanded.as_os_str().is_empty() {
            return if expanded.is_absolute() {
                expanded
            } else {
                absolute_path(workspace_path).join(expanded)
            };
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
}

fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn absolute_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn paths_equal(left: &str, right: &str) -> bool {
    let left = absolute_path(left);
    let right = absolute_path(right);
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn extract_message_text(message: &Value) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn preview_text(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    let mut chars = trimmed.chars();
    let preview: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{}...", preview)
    } else {
        preview
    }
}

fn parse_rfc3339(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_pi_session_directory_like_the_cli() {
        assert_eq!(
            encode_pi_cwd("/Users/name/My Project"),
            "--Users-name-My Project--"
        );
        assert_eq!(
            encode_pi_cwd(r"C:\Users\name\project"),
            "--C--Users-name-project--"
        );
    }

    #[test]
    fn reads_project_session_dir_setting() {
        let workspace =
            std::env::temp_dir().join(format!("shelf-pi-settings-{}", uuid::Uuid::new_v4()));
        let settings_dir = workspace.join(".pi");
        fs::create_dir_all(&settings_dir).expect("settings dir should be created");
        fs::write(
            settings_dir.join("settings.json"),
            r#"{"sessionDir":".pi/custom-sessions"}"#,
        )
        .expect("settings fixture should be written");

        assert_eq!(
            read_project_session_dir(&workspace.to_string_lossy()).as_deref(),
            Some(".pi/custom-sessions")
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn parses_header_only_pi_session() {
        let content = r#"{"type":"session","version":3,"id":"empty-session","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/tmp/project"}
"#;
        let session = parse_pi_session_content(content, "/tmp/empty.jsonl")
            .expect("pi session should parse")
            .expect("pi session should exist");

        assert_eq!(session.id, "empty-session");
        assert_eq!(session.display_title, "(untitled)");
        assert_eq!(session.message_count, 0);
        assert_eq!(session.updated_at, "2026-01-02T03:04:05+00:00");
    }

    #[test]
    fn parses_pi_session_metadata_and_text_blocks() {
        let content = r#"{"type":"session","version":3,"id":"session-1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/tmp/project"}
{"type":"session_info","id":"a","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","name":"Initial name"}
{"type":"message","id":"b","parentId":"a","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"user","content":[{"type":"text","text":"Please inspect the project"}],"timestamp":1767323047000}}
{"type":"message","id":"c","parentId":"b","timestamp":"2026-01-02T03:04:08.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"ok"}],"timestamp":1767323048000}}
{"type":"message","id":"d","parentId":"c","timestamp":"2026-01-02T03:04:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Done"}],"timestamp":1767323049000}}
{"type":"session_info","id":"e","parentId":"d","timestamp":"2026-01-02T03:04:10.000Z","name":"Final name"}
"#;
        let session = parse_pi_session_content(content, "/tmp/session.jsonl")
            .expect("pi session should parse")
            .expect("pi session should exist");

        assert_eq!(session.id, "session-1");
        assert_eq!(session.cwd, "/tmp/project");
        assert_eq!(session.display_title, "Final name");
        assert_eq!(session.custom_title.as_deref(), Some("Final name"));
        assert_eq!(
            session.first_prompt.as_deref(),
            Some("Please inspect the project")
        );
        assert_eq!(session.message_count, 3);
        assert_eq!(session.version, "3");
        assert_eq!(session.provider, SessionProvider::Pi);
    }
}
