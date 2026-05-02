use crate::session::Session;
use chrono::{DateTime, Utc};
use std::fs;
use std::path::PathBuf;

pub fn scan_sessions(workspace_path: &str) -> Result<Vec<Session>, String> {
    let sanitized = sanitize_path(workspace_path);
    let projects_dir = get_projects_dir();

    let session_dir = projects_dir.join(&sanitized);
    if !session_dir.exists() || !session_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();

    let entries = fs::read_dir(&session_dir).map_err(|e| format!("Failed to read sessions dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.extension().map_or(false, |ext| ext == "jsonl") {
            if let Ok(Some(session)) = parse_session_file(&path) {
                sessions.push(session);
            }
        }
    }

    sessions.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(sessions)
}

fn parse_session_file(path: &PathBuf) -> Result<Option<Session>, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut started_at = String::new();
    let mut updated_at: Option<DateTime<Utc>> = None;
    let mut version = String::new();
    let mut message_count = 0usize;

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        message_count += 1;
        if let Some(timestamp) = value["timestamp"].as_str() {
            if let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) {
                let parsed_utc = parsed.with_timezone(&Utc);
                updated_at = Some(updated_at.map_or(parsed_utc, |current| current.max(parsed_utc)));
            }
        }

        let msg_type = value["type"].as_str().unwrap_or("");

        match msg_type {
            "user" => {
                if first_prompt.is_none() {
                    if let Some(content) = value["message"]["content"].as_str() {
                        let trimmed = content.trim();
                        let preview: String = trimmed
                            .chars()
                            .take(80)
                            .collect();
                        first_prompt = Some(if trimmed.len() > 80 {
                            format!("{}...", preview)
                        } else {
                            preview
                        });
                    }
                }
                if session_id.is_empty() {
                    session_id = value["sessionId"].as_str().unwrap_or("").to_string();
                }
                if cwd.is_empty() {
                    cwd = value["cwd"].as_str().unwrap_or("").to_string();
                }
                if started_at.is_empty() {
                    started_at = value["timestamp"].as_str().unwrap_or("").to_string();
                }
                if version.is_empty() {
                    version = value["version"].as_str().unwrap_or("").to_string();
                }
            }
            "custom-title" => {
                custom_title = value["customTitle"].as_str().map(|s| s.to_string());
            }
            "ai-title" => {
                ai_title = value["aiTitle"].as_str().map(|s| s.to_string());
            }
            _ => {}
        }
    }

    if session_id.is_empty() {
        return Ok(None);
    }

    let display_title = custom_title
        .clone()
        .or_else(|| ai_title.clone())
        .or_else(|| first_prompt.clone())
        .unwrap_or_else(|| "(untitled)".to_string());
    let updated_at = updated_at
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| started_at.clone());

    Ok(Some(Session {
        id: session_id,
        cwd,
        display_title,
        custom_title,
        ai_title,
        first_prompt,
        message_count,
        started_at,
        updated_at,
        file_path: path.to_string_lossy().to_string(),
        version,
    }))
}

pub fn sanitize_path(path: &str) -> String {
    path.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn get_projects_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join(".claude").join("projects")
    } else {
        PathBuf::from(".claude/projects")
    }
}
