use super::*;
use std::collections::BTreeMap;

pub(super) fn path_matches_mounted_workspace(
    workspace: &Workspace,
    path: &str,
    provider: SessionProvider,
) -> bool {
    workspace.provider == provider && paths_equal(&workspace.path, path)
}

pub(super) fn paths_equal(left: &str, right: &str) -> bool {
    let left_path = Path::new(left);
    let right_path = Path::new(right);
    if left_path == right_path {
        return true;
    }
    match (fs::canonicalize(left_path), fs::canonicalize(right_path)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

pub(super) fn mounted_workspace_for_path(
    path: &str,
    provider: SessionProvider,
) -> Result<Workspace, AiToolError> {
    load_config()
        .workspaces
        .into_iter()
        .find(|workspace| path_matches_mounted_workspace(workspace, path, provider))
        .ok_or_else(|| {
            AiToolError::Failed(format!(
                "Mounted path '{}' for provider {:?} was not found in Shelf config",
                path, provider
            ))
        })
}

pub(super) fn mounted_workspaces_for_path(path: Option<&str>) -> Vec<Workspace> {
    load_config()
        .workspaces
        .into_iter()
        .filter(|workspace| path.is_none_or(|path| paths_equal(&workspace.path, path)))
        .collect()
}

pub(super) fn scan_claude_sessions(path: &str) -> Result<Vec<Session>, AiToolError> {
    let workspace = mounted_workspace_for_path(path, SessionProvider::Claude)?;
    crate::session::scan_sessions(&workspace.path).map_err(AiToolError::Failed)
}

pub(super) fn scan_codex_sessions(path: &str) -> Result<Vec<Session>, AiToolError> {
    let workspace = mounted_workspace_for_path(path, SessionProvider::Codex)?;
    crate::commands::sessions::scan_codex_sessions(workspace.path).map_err(AiToolError::Failed)
}

#[derive(Debug, Clone)]
pub(super) struct SearchableSessionRecord {
    provider: SessionProvider,
    id: String,
    file_path: PathBuf,
}

pub(super) fn session_to_tool_value(session: Session) -> Value {
    json!({
        "id": session.id,
        "title": session.display_title,
        "cwd": session.cwd,
        "firstPrompt": session.first_prompt,
        "messageCount": session.message_count,
        "startedAt": session.started_at,
        "updatedAt": session.updated_at,
        "filePath": absolute_path_string(&session.file_path),
        "version": session.version,
        "provider": session.provider,
    })
}

pub(super) fn absolute_path_string(path: &str) -> String {
    absolute_path_from_path(Path::new(path))
}

pub(super) fn absolute_path_from_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

pub(super) fn path_is_under(path: &Path, parent: &Path) -> bool {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    path.starts_with(parent)
}

pub(super) fn is_ai_session_record_path(path: &Path) -> bool {
    let Some(home_dir) = dirs::home_dir() else {
        return false;
    };
    let claude_records_dir = home_dir.join(".claude").join("projects");
    let codex_records_dir = home_dir.join(".codex").join("sessions");
    path_is_under(path, &claude_records_dir) || path_is_under(path, &codex_records_dir)
}

pub(super) fn provider_label(provider: SessionProvider) -> &'static str {
    match provider {
        SessionProvider::Claude => "Claude code",
        SessionProvider::Codex => "codex",
    }
}

pub(super) fn provider_key(provider: SessionProvider) -> &'static str {
    match provider {
        SessionProvider::Claude => "claude",
        SessionProvider::Codex => "codex",
    }
}

pub(super) fn mapped_session_key(provider: SessionProvider, session_id: &str) -> String {
    format!("{}:{}", provider_key(provider), session_id)
}

pub(super) fn normalize_ai_tags(tags: Option<Vec<String>>) -> Vec<String> {
    let mut tags = tags
        .unwrap_or_default()
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    tags
}

pub(super) fn category_exists(category_id: &str, map: &AiSessionMap) -> Result<(), AiToolError> {
    if map.groups.contains_key(category_id) {
        Ok(())
    } else {
        Err(AiToolError::Failed(format!(
            "AI category '{}' does not exist",
            category_id
        )))
    }
}

pub(super) fn mapped_session_exists(provider: SessionProvider, session_id: &str) -> bool {
    mounted_session(provider, session_id).is_ok()
}

pub(super) fn mounted_session(
    provider: SessionProvider,
    session_id: &str,
) -> Result<Session, AiToolError> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(AiToolError::Failed("sessionId is required".to_string()));
    }

    load_config()
        .workspaces
        .into_iter()
        .filter(|workspace| workspace.provider == provider)
        .find_map(|workspace| {
            let sessions = match provider {
                SessionProvider::Claude => crate::session::scan_sessions(&workspace.path),
                SessionProvider::Codex => {
                    crate::commands::sessions::scan_codex_sessions(workspace.path)
                }
            };
            sessions
                .ok()?
                .into_iter()
                .find(|session| session.id == session_id)
        })
        .ok_or_else(|| {
            AiToolError::Failed(format!(
                "Session '{}' for provider '{}' is not mounted in Shelf",
                session_id,
                provider_key(provider)
            ))
        })
}

pub(super) fn mounted_session_file(
    provider: SessionProvider,
    session_id: &str,
) -> Result<PathBuf, AiToolError> {
    let session = mounted_session(provider, session_id)?;
    let file_path = PathBuf::from(session.file_path);
    if file_path.as_os_str().is_empty() || !file_path.is_file() {
        return Err(AiToolError::Failed(format!(
            "Mounted session '{}' for provider '{}' has no readable record file",
            session_id,
            provider_key(provider)
        )));
    }
    Ok(file_path)
}

pub(super) fn claude_session_dir(workspace_path: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
        .join(crate::session::sanitize_path(workspace_path))
}

pub(super) fn collect_regular_files(dir: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect::<Vec<_>>();
    paths.sort();

    for path in paths {
        if path.is_dir() {
            collect_regular_files(&path, output);
        } else if path.is_file() {
            output.push(path);
        }
    }
}

pub(super) fn session_id_from_path(path: &Path) -> String {
    path.file_stem()
        .or_else(|| path.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string()
}

pub(super) fn insert_searchable_record(
    records: &mut BTreeMap<String, SearchableSessionRecord>,
    record: SearchableSessionRecord,
) {
    let key = absolute_path_from_path(&record.file_path);
    records.entry(key).or_insert(record);
}

pub(super) fn configured_session_record_files(
    path: Option<&str>,
) -> Result<Vec<SearchableSessionRecord>, AiToolError> {
    let mut records = BTreeMap::new();
    let workspaces = mounted_workspaces_for_path(path);
    if path.is_some() && workspaces.is_empty() {
        return Err(AiToolError::Failed(format!(
            "Mounted path '{}' was not found in Shelf config",
            path.unwrap_or_default()
        )));
    }

    for workspace in workspaces {
        match workspace.provider {
            SessionProvider::Claude => {
                let mut files = Vec::new();
                collect_regular_files(&claude_session_dir(&workspace.path), &mut files);
                for file_path in files {
                    insert_searchable_record(
                        &mut records,
                        SearchableSessionRecord {
                            provider: SessionProvider::Claude,
                            id: session_id_from_path(&file_path),
                            file_path,
                        },
                    );
                }
            }
            SessionProvider::Codex => {
                let Ok(sessions) = crate::commands::sessions::scan_codex_sessions(workspace.path)
                else {
                    continue;
                };
                for session in sessions {
                    if session.file_path.trim().is_empty() {
                        continue;
                    }
                    insert_searchable_record(
                        &mut records,
                        SearchableSessionRecord {
                            provider: SessionProvider::Codex,
                            id: session.id,
                            file_path: PathBuf::from(session.file_path),
                        },
                    );
                }
            }
        }
    }
    Ok(records.into_values().collect())
}

pub(super) fn search_session_record_file(
    record: &SearchableSessionRecord,
    query: &str,
    output: &mut LimitedTextOutput,
) {
    if output.truncated {
        return;
    }

    let Ok(file) = fs::File::open(&record.file_path) else {
        return;
    };

    let mut header_written = false;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else {
            continue;
        };
        if line.contains(query) {
            if !header_written {
                if !output.push_str(&format!(
                    "{} [{}]\nfilePath: {}\n",
                    provider_label(record.provider),
                    record.id,
                    absolute_path_from_path(&record.file_path)
                )) {
                    return;
                }
                header_written = true;
            }

            if !output.push_str(&format!("[{}] {}\n", index + 1, line)) {
                return;
            }
        }
    }

    if header_written {
        output.push_str("---\n");
    }
}

pub(super) fn read_lines(path: &str) -> Result<Vec<String>, AiToolError> {
    fs::read_to_string(path)
        .map_err(|e| AiToolError::Failed(format!("Read file '{}': {}", path, e)))
        .map(|content| content.lines().map(ToString::to_string).collect())
}

pub(super) fn read_record_lines(path: &Path) -> Result<Vec<String>, AiToolError> {
    fs::read_to_string(path)
        .map_err(|e| AiToolError::Failed(format!("Read file '{}': {}", path.display(), e)))
        .map(|content| content.lines().map(ToString::to_string).collect())
}

pub(super) fn checked_line_range(
    total_lines: usize,
    start_line: usize,
    end_line: usize,
) -> Result<(usize, usize), AiToolError> {
    if start_line == 0 || end_line == 0 {
        return Err(AiToolError::Failed("Line numbers are 1-based".to_string()));
    }
    if start_line > end_line {
        return Err(AiToolError::Failed(
            "startLine must be less than or equal to endLine".to_string(),
        ));
    }
    if end_line > total_lines {
        return Err(AiToolError::Failed(format!(
            "Requested endLine {} exceeds file length {}",
            end_line, total_lines
        )));
    }
    Ok((start_line - 1, end_line))
}

pub(super) fn checked_read_line_range(
    total_lines: usize,
    start_line: usize,
    end_line: usize,
) -> Result<(usize, usize), AiToolError> {
    let (start, end) = checked_line_range(total_lines, start_line, end_line)?;
    let requested_lines = end - start;
    if requested_lines > AI_MAX_READ_FILE_LINES {
        return Err(AiToolError::Failed(format!(
            "Requested {} lines exceeds the read limit of {} lines",
            requested_lines, AI_MAX_READ_FILE_LINES
        )));
    }
    Ok((start, end))
}

pub(super) fn validate_session_record_lines(
    provider: SessionProvider,
    lines: &[String],
) -> Result<(), AiToolError> {
    if lines.is_empty() {
        return Err(AiToolError::Failed(
            "Session record cannot be empty".to_string(),
        ));
    }

    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        serde_json::from_str::<Value>(line).map_err(|e| {
            AiToolError::Failed(format!(
                "Replacement would make {} JSONL invalid at line {}: {}",
                provider_label(provider),
                index + 1,
                e
            ))
        })?;
    }

    Ok(())
}

pub(super) fn replace_session_record_lines(
    provider: SessionProvider,
    session_id: &str,
    start_line: usize,
    end_line: usize,
    replacement: &str,
) -> Result<Value, AiToolError> {
    let file_path = mounted_session_file(provider, session_id)?;
    let original = fs::read_to_string(&file_path)
        .map_err(|e| AiToolError::Failed(format!("Read file '{}': {}", file_path.display(), e)))?;
    let had_trailing_newline = original.ends_with('\n');
    let mut lines = original
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let (start, end) = checked_line_range(lines.len(), start_line, end_line)?;
    let replacement_lines = replacement
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    lines.splice(start..end, replacement_lines);
    validate_session_record_lines(provider, &lines)?;

    let mut content = lines.join("\n");
    if had_trailing_newline {
        content.push('\n');
    }
    fs::write(&file_path, content)
        .map_err(|e| AiToolError::Failed(format!("Write file '{}': {}", file_path.display(), e)))?;

    Ok(limited_json_output(json!({
        "ok": true,
        "provider": provider,
        "sessionId": session_id,
        "filePath": absolute_path_from_path(&file_path),
        "startLine": start_line,
        "endLine": end_line,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_record_validation_accepts_valid_claude_jsonl_only() {
        let valid = vec![
            r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":"hello"}}"#.to_string(),
            r#"{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":"ok"}}"#.to_string(),
        ];
        assert!(validate_session_record_lines(SessionProvider::Claude, &valid).is_ok());

        let invalid = vec![
            r#"{"type":"user","sessionId":"s1"}"#.to_string(),
            r#"{"type":"assistant","sessionId":"s1""#.to_string(),
        ];
        assert!(validate_session_record_lines(SessionProvider::Claude, &invalid).is_err());
    }

    #[test]
    fn session_record_validation_accepts_valid_codex_json_only() {
        let valid = vec![
            r#"{"type":"session_meta","id":"s1"}"#.to_string(),
            r#"{"type":"response_item","payload":{"type":"message","role":"user"}}"#.to_string(),
        ];
        assert!(validate_session_record_lines(SessionProvider::Codex, &valid).is_ok());

        let invalid = vec![
            r#"{"type":"session_meta","id":"s1"}"#.to_string(),
            r#"{"type":"response_item""#.to_string(),
        ];
        assert!(validate_session_record_lines(SessionProvider::Codex, &invalid).is_err());
    }

    #[test]
    fn ai_session_record_path_detects_known_record_dirs() {
        let Some(home_dir) = dirs::home_dir() else {
            return;
        };
        assert!(is_ai_session_record_path(
            &home_dir.join(".claude/projects/demo/session.jsonl")
        ));
        assert!(is_ai_session_record_path(
            &home_dir.join(".codex/sessions/2026/01/01/rollout.jsonl")
        ));
        assert!(!is_ai_session_record_path(
            &home_dir.join("Desktop/project/demo.jsonl")
        ));
    }
}
