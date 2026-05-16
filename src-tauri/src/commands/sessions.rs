use crate::session::{sanitize_path, Session, SessionProvider};
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};

#[tauri::command]
pub fn scan_sessions(workspace_path: String) -> Result<Vec<Session>, String> {
    crate::session::scan_sessions(&workspace_path)
}

#[tauri::command]
pub fn scan_codex_sessions(workspace_path: String) -> Result<Vec<Session>, String> {
    let db_path = codex_state_db_path()?;
    if !db_path.exists() {
        return Ok(Vec::new());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("Open Codex db: {}", e))?;
    let workspace_candidates = path_candidates(&workspace_path);
    let mut stmt = conn
        .prepare(
            "select id, \
                    coalesce(title, ''), \
                    coalesce(cwd, ''), \
                    coalesce(first_user_message, ''), \
                    coalesce(created_at_ms, created_at * 1000), \
                    coalesce(updated_at_ms, updated_at * 1000), \
                    coalesce(rollout_path, ''), \
                    coalesce(cli_version, '') \
             from threads \
             where archived = 0 \
             order by coalesce(updated_at_ms, updated_at * 1000) desc, id desc",
        )
        .map_err(|e| format!("Prepare Codex query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let cwd: String = row.get(2)?;
            let first_user_message: String = row.get(3)?;
            let created_at_ms: Option<i64> = row.get(4)?;
            let updated_at_ms: Option<i64> = row.get(5)?;
            let rollout_path: String = row.get(6)?;
            let cli_version: String = row.get(7)?;
            let started_at = ms_to_rfc3339(created_at_ms).unwrap_or_default();
            let updated_at = ms_to_rfc3339(updated_at_ms).unwrap_or_else(|| started_at.clone());
            Ok(Session {
                id,
                cwd,
                display_title: if title.trim().is_empty() {
                    "(untitled)".to_string()
                } else {
                    title
                },
                custom_title: None,
                ai_title: None,
                first_prompt: if first_user_message.trim().is_empty() {
                    None
                } else {
                    Some(first_user_message)
                },
                message_count: 0,
                started_at,
                updated_at,
                file_path: rollout_path,
                version: cli_version,
                provider: SessionProvider::Codex,
            })
        })
        .map_err(|e| format!("Query Codex sessions: {}", e))?;

    let mut sessions = Vec::new();
    for row in rows {
        match row {
            Ok(session) => {
                if path_is_in_workspace(&session.cwd, &workspace_candidates) {
                    sessions.push(session);
                }
            }
            Err(e) => eprintln!("[Shelf] skipped invalid Codex session row: {}", e),
        }
    }
    Ok(sessions)
}

fn path_candidates(path: &str) -> Vec<String> {
    let mut candidates = vec![normalize_path(path)];
    if let Ok(canonical) = fs::canonicalize(path) {
        candidates.push(normalize_path(&canonical.to_string_lossy()));
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn path_is_in_workspace(path: &str, workspace_candidates: &[String]) -> bool {
    let path_candidates = path_candidates(path);
    path_candidates.iter().any(|candidate| {
        workspace_candidates
            .iter()
            .any(|workspace| path_equal_or_nested(candidate, workspace))
    })
}

fn path_equal_or_nested(path: &str, workspace: &str) -> bool {
    path == workspace || (workspace != "/" && path.starts_with(&format!("{}/", workspace)))
}

fn codex_state_db_path() -> Result<PathBuf, String> {
    let codex_dir = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".codex");

    let mut newest: Option<(u64, PathBuf)> = None;
    if let Ok(entries) = fs::read_dir(&codex_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(version) = name
                .strip_prefix("state_")
                .and_then(|rest| rest.strip_suffix(".sqlite"))
                .and_then(|number| number.parse::<u64>().ok())
            else {
                continue;
            };
            if newest
                .as_ref()
                .map_or(true, |(current, _)| version > *current)
            {
                newest = Some((version, path));
            }
        }
    }

    Ok(newest
        .map(|(_, path)| path)
        .unwrap_or_else(|| codex_dir.join("state_5.sqlite")))
}

fn ms_to_rfc3339(value: Option<i64>) -> Option<String> {
    let ms = value?;
    let dt: DateTime<Utc> = Utc.timestamp_millis_opt(ms).single()?;
    Some(dt.to_rfc3339())
}

#[tauri::command]
pub fn create_session(workspace_path: String) -> Result<serde_json::Value, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let projects_dir = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".claude")
        .join("projects");
    let sanitized = sanitize_path(&workspace_path);
    let project_dir = projects_dir.join(&sanitized);
    fs::create_dir_all(&project_dir).map_err(|e| format!("Cannot create project dir: {}", e))?;

    let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
    let entry = serde_json::json!({
        "type": "user",
        "uuid": uuid::Uuid::new_v4().to_string(),
        "sessionId": session_id,
        "cwd": workspace_path,
        "timestamp": now,
        "version": "",
        "userType": "external",
        "entrypoint": "cli",
        "message": { "role": "user", "content": "" },
    });
    let line = serde_json::to_string(&entry).map_err(|e| format!("Serialize: {}", e))?;
    fs::write(&jsonl_path, line + "\n").map_err(|e| format!("Write: {}", e))?;

    Ok(serde_json::json!({ "sessionId": session_id }))
}

#[tauri::command]
pub fn rename_session(
    session_id: String,
    new_title: String,
    provider: Option<SessionProvider>,
) -> Result<(), String> {
    if matches!(provider, Some(SessionProvider::Codex)) {
        return rename_codex_session(&session_id, &new_title);
    }

    println!(
        "[Rust] rename_session: id={}, title={}",
        session_id, new_title
    );
    let projects_dir = if let Some(home) = dirs::home_dir() {
        home.join(".claude").join("projects")
    } else {
        return Err("Cannot find home directory".to_string());
    };
    println!("[Rust] projects_dir: {:?}", projects_dir);

    let entries =
        fs::read_dir(&projects_dir).map_err(|e| format!("Cannot read projects dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
        if jsonl_path.exists() {
            println!("[Rust] found jsonl: {:?}", jsonl_path);
            let entry = serde_json::json!({
                "type": "custom-title",
                "customTitle": new_title,
                "sessionId": session_id,
                "timestamp": chrono::Utc::now().to_rfc3339(),
            });
            let line =
                serde_json::to_string(&entry).map_err(|e| format!("Serialize error: {}", e))?;
            let mut content = fs::read_to_string(&jsonl_path).unwrap_or_default();
            if !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(&line);
            content.push('\n');
            fs::write(&jsonl_path, content).map_err(|e| format!("Write error: {}", e))?;
            println!("[Rust] rename_session: written OK");
            return Ok(());
        }
    }
    if provider.is_none() {
        rename_codex_session(&session_id, &new_title)
    } else {
        Err(format!("Session file not found for id: {}", session_id))
    }
}

#[tauri::command]
pub fn delete_session(session_id: String, provider: Option<SessionProvider>) -> Result<(), String> {
    if matches!(provider, Some(SessionProvider::Codex)) {
        return delete_codex_session(&session_id);
    }

    let projects_dir = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".claude")
        .join("projects");

    let entries =
        fs::read_dir(&projects_dir).map_err(|e| format!("Cannot read projects dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
        if jsonl_path.exists() {
            trash::delete(&jsonl_path).map_err(|e| format!("Trash error: {}", e))?;
            println!("[Rust] delete_session: moved to trash {:?}", jsonl_path);
            return Ok(());
        }
    }
    if provider.is_none() {
        delete_codex_session(&session_id)
    } else {
        Err(format!("Session file not found for id: {}", session_id))
    }
}

fn rename_codex_session(session_id: &str, new_title: &str) -> Result<(), String> {
    let db_path = codex_state_db_path()?;
    if !db_path.exists() {
        return Err("Codex state database not found".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("Open Codex db: {}", e))?;
    let now = Utc::now();
    let changed = conn
        .execute(
            "update threads \
             set title = ?1, updated_at = ?2, updated_at_ms = ?3 \
             where id = ?4 and archived = 0",
            params![
                new_title,
                now.timestamp(),
                now.timestamp_millis(),
                session_id
            ],
        )
        .map_err(|e| format!("Rename Codex session: {}", e))?;
    if changed == 0 {
        return Err(format!("Codex session not found for id: {}", session_id));
    }
    Ok(())
}

fn delete_codex_session(session_id: &str) -> Result<(), String> {
    let db_path = codex_state_db_path()?;
    if !db_path.exists() {
        return Err("Codex state database not found".to_string());
    }

    let mut conn = Connection::open(&db_path).map_err(|e| format!("Open Codex db: {}", e))?;
    let rollout_path = {
        let tx = conn
            .transaction()
            .map_err(|e| format!("Start Codex delete transaction: {}", e))?;
        let rollout_path: String = tx
            .query_row(
                "select coalesce(rollout_path, '') from threads where id = ?1 and archived = 0",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Codex session not found for id {}: {}", session_id, e))?;

        let now = Utc::now();
        let changed = tx
            .execute(
                "update threads \
                 set archived = 1, archived_at = ?1, updated_at = ?2, updated_at_ms = ?3 \
                 where id = ?4 and archived = 0",
                params![
                    now.timestamp(),
                    now.timestamp(),
                    now.timestamp_millis(),
                    session_id
                ],
            )
            .map_err(|e| format!("Archive Codex session: {}", e))?;
        if changed == 0 {
            return Err(format!("Codex session not found for id: {}", session_id));
        }
        tx.commit()
            .map_err(|e| format!("Commit Codex delete transaction: {}", e))?;
        rollout_path
    };

    match archive_codex_rollout_path(&rollout_path) {
        Ok(archived_rollout_path) => {
            if archived_rollout_path != rollout_path {
                conn.execute(
                    "update threads set rollout_path = ?1 where id = ?2",
                    params![archived_rollout_path, session_id],
                )
                .map_err(|e| format!("Update archived Codex rollout path: {}", e))?;
            }
        }
        Err(e) => eprintln!(
            "[Shelf] Codex session {} archived in db, but rollout move failed: {}",
            session_id, e
        ),
    }
    Ok(())
}

fn archive_codex_rollout_path(rollout_path: &str) -> Result<String, String> {
    let path = PathBuf::from(rollout_path);
    if !path.exists() {
        return Ok(rollout_path.to_string());
    }

    let archive_dir = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".codex")
        .join("archived_sessions");
    fs::create_dir_all(&archive_dir).map_err(|e| format!("Create Codex archive dir: {}", e))?;

    let file_name = path
        .file_name()
        .ok_or("Codex rollout path has no file name")?;
    let mut destination = archive_dir.join(file_name);
    if destination.exists() {
        destination = next_available_archive_path(&archive_dir, Path::new(file_name));
    }

    fs::rename(&path, &destination).map_err(|e| format!("Move Codex rollout to archive: {}", e))?;
    Ok(destination.to_string_lossy().to_string())
}

fn next_available_archive_path(archive_dir: &Path, file_name: &Path) -> PathBuf {
    let stem = file_name
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("rollout");
    let ext = file_name
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");

    for index in 1.. {
        let candidate_name = if ext.is_empty() {
            format!("{}-{}", stem, index)
        } else {
            format!("{}-{}.{}", stem, index, ext)
        };
        let candidate = archive_dir.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("unbounded archive path search should always return")
}
