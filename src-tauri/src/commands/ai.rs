use crate::session::{Session, SessionProvider, ShelfConfig, Workspace};
use futures_util::StreamExt;
use rig_core::{
    agent::{HookAction, MultiTurnStreamItem, PromptHook, ToolCallHookAction},
    completion::{CompletionModel, ToolDefinition},
    http_client::ReqwestClient,
    message::{Message, ToolChoice, ToolResultContent},
    prelude::CompletionClient,
    providers::openai,
    streaming::{StreamedAssistantContent, StreamedUserContent, StreamingPrompt},
    tool::Tool,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};
use url::Url;

type AiResult<T> = Result<T, String>;
const AI_STREAM_EVENT: &str = "shelf://ai-stream";
const AI_MAX_TOOL_TURNS: usize = 30;
const AI_MAX_TOOL_RESULT_CHARS: usize = 24_000;
const AI_MAX_READ_FILE_LINES: usize = 400;

#[derive(Debug, thiserror::Error)]
enum AiToolError {
    #[error("{0}")]
    Failed(String),
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSettings {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSessionMap {
    pub version: u32,
    pub groups: BTreeMap<String, AiGroup>,
    pub sessions: BTreeMap<String, AiSessionMeta>,
}

impl Default for AiSessionMap {
    fn default() -> Self {
        Self {
            version: 1,
            groups: BTreeMap::new(),
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AiGroup {
    pub id: String,
    pub workspace_path: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSessionMeta {
    pub alias_title: Option<String>,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiRunRequest {
    pub message: String,
    #[serde(default)]
    pub history: Vec<AiHistoryMessage>,
    pub workspace_path: Option<String>,
    pub provider: Option<SessionProvider>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiHistoryMessage {
    pub role: String,
    pub content: String,
    pub tool: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiRunResponse {
    pub message: String,
    pub map: AiSessionMap,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    pub kind: String,
    pub id: Option<String>,
    pub text: Option<String>,
    pub tool: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiModelListResponse {
    pub base_url: String,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoArgs {}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountedPathArgs {
    path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchSessionRecordsArgs {
    query: String,
    path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadFileLinesArgs {
    file_path: String,
    start_line: usize,
    end_line: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceFileLinesArgs {
    file_path: String,
    start_line: usize,
    end_line: usize,
    replacement: String,
}

struct LimitedTextOutput {
    text: String,
    used_chars: usize,
    max_chars: usize,
    truncated: bool,
}

impl LimitedTextOutput {
    fn new(max_chars: usize) -> Self {
        Self {
            text: String::new(),
            used_chars: 0,
            max_chars,
            truncated: false,
        }
    }

    fn push_str(&mut self, value: &str) -> bool {
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

    fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    fn into_string(mut self) -> String {
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

fn ai_settings_path() -> PathBuf {
    shelf_dir().join("ai_settings.json")
}

fn ai_session_map_path() -> PathBuf {
    shelf_dir().join("ai_sessions.json")
}

fn config_path() -> PathBuf {
    shelf_dir().join("config.json")
}

fn save_json<T: Serialize>(path: &Path, value: &T) -> AiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create config dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(value).map_err(|e| format!("Serialize: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Write {}: {}", path.display(), e))
}

fn load_ai_settings() -> AiSettings {
    fs::read_to_string(ai_settings_path())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn load_ai_map() -> AiSessionMap {
    fs::read_to_string(ai_session_map_path())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_ai_map(map: &AiSessionMap) -> AiResult<()> {
    save_json(&ai_session_map_path(), map)
}

fn load_config() -> ShelfConfig {
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

fn ai_model_base_url_candidates(base_url: &str) -> Vec<String> {
    let base = normalize_ai_base_url_input(base_url);
    if base.is_empty() {
        return Vec::new();
    }

    let mut candidates = Vec::new();
    push_unique_candidate(&mut candidates, base.clone());
    if let Some(root) = base_url_version_root(&base) {
        push_unique_candidate(&mut candidates, format!("{}/v1", root));
    } else {
        if !base.ends_with("/v1") {
            push_unique_candidate(&mut candidates, format!("{}/v1", base));
        }
    }
    candidates
}

fn normalize_ai_base_url_input(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    if let Some(prefix) = base.strip_suffix("/models") {
        base = prefix.to_string();
    }
    base
}

fn push_unique_candidate(candidates: &mut Vec<String>, candidate: String) {
    if !candidate.trim().is_empty() && !candidates.iter().any(|item| item == &candidate) {
        candidates.push(candidate);
    }
}

fn base_url_version_root(base_url: &str) -> Option<String> {
    let mut url = Url::parse(base_url).ok()?;
    let path = url.path().trim_end_matches('/').to_string();
    let root_path = if path == "/v1" {
        String::new()
    } else if let Some(prefix) = path.strip_suffix("/v1") {
        prefix.to_string()
    } else {
        path
    };
    if root_path.is_empty() {
        url.set_path("");
    } else {
        url.set_path(&root_path);
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.as_str().trim_end_matches('/').to_string())
}

fn ai_models_endpoint(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

fn normalized_bearer_token(api_key: &str) -> String {
    let trimmed = api_key.trim();
    trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

fn model_id_from_value(value: &Value) -> Option<String> {
    if let Some(id) = value.as_str() {
        return Some(id.to_string());
    }
    value
        .get("id")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn model_ids_from_response(value: Value) -> Vec<String> {
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| value.as_array().cloned())
        .unwrap_or_default();

    let mut models: Vec<String> = entries
        .iter()
        .filter_map(model_id_from_value)
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    models.sort();
    models.dedup();
    models
}

fn truncate_string(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }

    let mut output = value.chars().take(max_chars).collect::<String>();
    output.push_str(&format!(
        "\n[truncated: value exceeded {} characters]",
        max_chars
    ));
    output
}

fn limited_json_output(value: Value) -> Value {
    let serialized = serde_json::to_string(&value).unwrap_or_else(|_| value.to_string());
    if serialized.chars().count() <= AI_MAX_TOOL_RESULT_CHARS {
        return value;
    }

    json!({
        "truncated": true,
        "maxChars": AI_MAX_TOOL_RESULT_CHARS,
        "content": truncate_string(&serialized, AI_MAX_TOOL_RESULT_CHARS)
    })
}

async fn list_models_from_base_url(settings: &AiSettings, base_url: &str) -> AiResult<Vec<String>> {
    let endpoint = ai_models_endpoint(base_url);
    let token = normalized_bearer_token(&settings.api_key);
    let response = ReqwestClient::new()
        .get(&endpoint)
        .bearer_auth(token)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("List models request: {}", e))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Read models response: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "List models: HTTP {} with message: {}",
            status, body
        ));
    }

    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse models response: {}. Body: {}", e, body))?;
    let models = model_ids_from_response(value);
    if models.is_empty() {
        return Err(format!(
            "List models: response did not contain any model ids. Body: {}",
            body
        ));
    }
    Ok(models)
}

fn path_matches_mounted_workspace(
    workspace: &Workspace,
    path: &str,
    provider: SessionProvider,
) -> bool {
    workspace.provider == provider && paths_equal(&workspace.path, path)
}

fn paths_equal(left: &str, right: &str) -> bool {
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

fn mounted_workspace_for_path(
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

fn mounted_workspaces_for_path(path: Option<&str>) -> Vec<Workspace> {
    load_config()
        .workspaces
        .into_iter()
        .filter(|workspace| path.is_none_or(|path| paths_equal(&workspace.path, path)))
        .collect()
}

fn scan_claude_sessions(path: &str) -> Result<Vec<Session>, AiToolError> {
    let workspace = mounted_workspace_for_path(path, SessionProvider::Claude)?;
    crate::session::scan_sessions(&workspace.path).map_err(AiToolError::Failed)
}

fn scan_codex_sessions(path: &str) -> Result<Vec<Session>, AiToolError> {
    let workspace = mounted_workspace_for_path(path, SessionProvider::Codex)?;
    crate::commands::sessions::scan_codex_sessions(workspace.path).map_err(AiToolError::Failed)
}

#[derive(Debug, Clone)]
struct SearchableSessionRecord {
    provider: SessionProvider,
    id: String,
    file_path: PathBuf,
}

fn session_to_tool_value(session: Session) -> Value {
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

fn absolute_path_string(path: &str) -> String {
    absolute_path_from_path(Path::new(path))
}

fn absolute_path_from_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn provider_label(provider: SessionProvider) -> &'static str {
    match provider {
        SessionProvider::Claude => "Claude code",
        SessionProvider::Codex => "codex",
    }
}

fn claude_session_dir(workspace_path: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
        .join(crate::session::sanitize_path(workspace_path))
}

fn collect_regular_files(dir: &Path, output: &mut Vec<PathBuf>) {
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

fn session_id_from_path(path: &Path) -> String {
    path.file_stem()
        .or_else(|| path.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn insert_searchable_record(
    records: &mut BTreeMap<String, SearchableSessionRecord>,
    record: SearchableSessionRecord,
) {
    let key = absolute_path_from_path(&record.file_path);
    records.entry(key).or_insert(record);
}

fn configured_session_record_files(
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

fn search_session_record_file(
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

fn read_lines(path: &str) -> Result<Vec<String>, AiToolError> {
    fs::read_to_string(path)
        .map_err(|e| AiToolError::Failed(format!("Read file '{}': {}", path, e)))
        .map(|content| content.lines().map(ToString::to_string).collect())
}

fn checked_line_range(
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

fn checked_read_line_range(
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

fn ai_history_to_messages(history: Vec<AiHistoryMessage>) -> Vec<Message> {
    history
        .into_iter()
        .filter_map(|item| {
            let content = item.content.trim();
            if content.is_empty() {
                return None;
            }
            match item.role.as_str() {
                "user" => Some(Message::user(content)),
                "assistant" => Some(Message::assistant(content)),
                "tool" => {
                    let tool = item.tool.unwrap_or_else(|| "tool".to_string());
                    Some(Message::user(format!(
                        "Tool result from {}:\n{}",
                        tool, content
                    )))
                }
                _ => None,
            }
        })
        .collect()
}

#[derive(Clone, Copy)]
struct ListMountedPathsTool;

impl Tool for ListMountedPathsTool {
    const NAME: &'static str = "list_mounted_paths";
    type Error = AiToolError;
    type Args = NoArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List only the directories currently mounted in Shelf's left sidebar. These paths come from Shelf config entries created by Add Workspace; this tool does not scan arbitrary folders. Large outputs are truncated.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mounted_paths = load_config()
            .workspaces
            .into_iter()
            .map(|workspace| {
                json!({
                    "name": workspace.name,
                    "path": absolute_path_string(&workspace.path),
                    "provider": workspace.provider,
                })
            })
            .collect::<Vec<_>>();
        Ok(limited_json_output(
            json!({ "mountedPaths": mounted_paths }),
        ))
    }
}

#[derive(Clone, Copy)]
struct ListClaudeSessionsTool;

impl Tool for ListClaudeSessionsTool {
    const NAME: &'static str = "list_claude_code_sessions";
    type Error = AiToolError;
    type Args = MountedPathArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List Claude Code session records for a mounted Shelf directory path. Use list_mounted_paths first to discover valid paths. Large outputs are truncated.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "A directory path currently mounted in Shelf's left sidebar." }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let sessions = scan_claude_sessions(&args.path)?;
        Ok(limited_json_output(json!({
            "path": absolute_path_string(&args.path),
            "provider": "claude",
            "sessions": sessions.into_iter().map(session_to_tool_value).collect::<Vec<_>>(),
        })))
    }
}

#[derive(Clone, Copy)]
struct ListCodexSessionsTool;

impl Tool for ListCodexSessionsTool {
    const NAME: &'static str = "list_codex_sessions";
    type Error = AiToolError;
    type Args = MountedPathArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List Codex session records for a mounted Shelf directory path. Use list_mounted_paths first to discover valid paths. Large outputs are truncated.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "A directory path currently mounted in Shelf's left sidebar." }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let sessions = scan_codex_sessions(&args.path)?;
        Ok(limited_json_output(json!({
            "path": absolute_path_string(&args.path),
            "provider": "codex",
            "sessions": sessions.into_iter().map(session_to_tool_value).collect::<Vec<_>>(),
        })))
    }
}

#[derive(Clone, Copy)]
struct SearchSessionRecordsTool;

impl Tool for SearchSessionRecordsTool {
    const NAME: &'static str = "search_session_records";
    type Error = AiToolError;
    type Args = SearchSessionRecordsArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search local Claude Code and Codex session files under Shelf-mounted directories. If path is omitted, searches every mounted directory. If path is provided, it must be a directory currently mounted in Shelf's left sidebar. Returns provider, session id, absolute filePath, line number, matched line, and --- separators. Output is truncated at a fixed limit; narrow the query or use read_file_lines with filePath and line numbers for details.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keyword to search for in local session JSON/JSONL files." },
                    "path": { "type": "string", "description": "Optional mounted directory path to search. Omit to search all mounted directories." }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        if args.query.is_empty() {
            return Err(AiToolError::Failed("query is required".to_string()));
        }
        let mut output = LimitedTextOutput::new(AI_MAX_TOOL_RESULT_CHARS);
        for record in configured_session_record_files(args.path.as_deref())? {
            search_session_record_file(&record, &args.query, &mut output);
            if output.truncated {
                break;
            }
        }
        if output.is_empty() {
            output.push_str("No matches found.\n");
        }
        Ok(output.into_string())
    }
}

#[derive(Clone, Copy)]
struct ReadFileLinesTool;

impl Tool for ReadFileLinesTool {
    const NAME: &'static str = "read_file_lines";
    type Error = AiToolError;
    type Args = ReadFileLinesArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Read a local file by 1-based inclusive line range. A single read is limited to a fixed number of lines, and the total tool result is size-limited.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "filePath": { "type": "string", "description": "Absolute file path." },
                    "startLine": { "type": "integer", "minimum": 1 },
                    "endLine": { "type": "integer", "minimum": 1 }
                },
                "required": ["filePath", "startLine", "endLine"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let lines = read_lines(&args.file_path)?;
        let (start, end) = checked_read_line_range(lines.len(), args.start_line, args.end_line)?;
        let selected = lines[start..end]
            .iter()
            .enumerate()
            .map(|(index, text)| {
                json!({
                    "line": args.start_line + index,
                    "text": text,
                })
            })
            .collect::<Vec<_>>();
        Ok(limited_json_output(json!({
            "filePath": absolute_path_string(&args.file_path),
            "startLine": args.start_line,
            "endLine": args.end_line,
            "maxLinesPerRead": AI_MAX_READ_FILE_LINES,
            "lines": selected,
        })))
    }
}

#[derive(Clone, Copy)]
struct ReplaceFileLinesTool;

impl Tool for ReplaceFileLinesTool {
    const NAME: &'static str = "replace_file_lines";
    type Error = AiToolError;
    type Args = ReplaceFileLinesArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description:
                "Replace a local file's 1-based inclusive line range with replacement text. The returned confirmation is size-limited."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "filePath": { "type": "string", "description": "Absolute file path." },
                    "startLine": { "type": "integer", "minimum": 1 },
                    "endLine": { "type": "integer", "minimum": 1 },
                    "replacement": { "type": "string", "description": "Replacement text. It may contain multiple lines." }
                },
                "required": ["filePath", "startLine", "endLine", "replacement"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let original = fs::read_to_string(&args.file_path)
            .map_err(|e| AiToolError::Failed(format!("Read file '{}': {}", args.file_path, e)))?;
        let had_trailing_newline = original.ends_with('\n');
        let mut lines = original
            .lines()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let (start, end) = checked_line_range(lines.len(), args.start_line, args.end_line)?;
        let replacement = args
            .replacement
            .lines()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        lines.splice(start..end, replacement);
        let mut content = lines.join("\n");
        if had_trailing_newline {
            content.push('\n');
        }
        fs::write(&args.file_path, content)
            .map_err(|e| AiToolError::Failed(format!("Write file '{}': {}", args.file_path, e)))?;
        Ok(limited_json_output(json!({
            "ok": true,
            "filePath": absolute_path_string(&args.file_path),
            "startLine": args.start_line,
            "endLine": args.end_line,
        })))
    }
}

#[derive(Clone)]
struct AiStreamHook {
    app: AppHandle,
}

fn emit_ai_event(
    app: &AppHandle,
    kind: &str,
    id: Option<String>,
    text: Option<String>,
    tool: Option<String>,
) {
    let _ = app.emit(
        AI_STREAM_EVENT,
        AiStreamEvent {
            kind: kind.to_string(),
            id,
            text,
            tool,
        },
    );
}

impl<M> PromptHook<M> for AiStreamHook
where
    M: CompletionModel,
{
    fn on_tool_call(
        &self,
        tool_name: &str,
        _tool_call_id: Option<String>,
        _internal_call_id: &str,
        _args: &str,
    ) -> impl Future<Output = ToolCallHookAction> + Send {
        let app = self.app.clone();
        let tool = tool_name.to_string();
        let id = _internal_call_id.to_string();
        let args = _args.to_string();
        async move {
            emit_ai_event(&app, "tool-start", Some(id), Some(args), Some(tool));
            ToolCallHookAction::cont()
        }
    }

    fn on_tool_result(
        &self,
        tool_name: &str,
        _tool_call_id: Option<String>,
        _internal_call_id: &str,
        _args: &str,
        result: &str,
    ) -> impl Future<Output = HookAction> + Send {
        let app = self.app.clone();
        let tool = tool_name.to_string();
        let id = _internal_call_id.to_string();
        let result = result.to_string();
        async move {
            emit_ai_event(&app, "tool-end", Some(id), Some(result), Some(tool));
            HookAction::cont()
        }
    }
}

fn tool_result_to_text(content: &rig_core::OneOrMany<ToolResultContent>) -> String {
    content
        .iter()
        .map(|item| match item {
            ToolResultContent::Text(text) => text.text.clone(),
            ToolResultContent::Image(_) => "[image]".to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub fn get_ai_settings() -> AiResult<AiSettings> {
    Ok(load_ai_settings())
}

#[tauri::command]
pub fn save_ai_settings(settings: AiSettings) -> AiResult<()> {
    save_json(&ai_settings_path(), &settings)
}

#[tauri::command]
pub fn get_ai_session_map() -> AiResult<AiSessionMap> {
    Ok(load_ai_map())
}

#[tauri::command]
pub fn save_ai_session_map(map: AiSessionMap) -> AiResult<()> {
    save_ai_map(&map)
}

#[tauri::command]
pub async fn list_ai_models(settings: Option<AiSettings>) -> AiResult<AiModelListResponse> {
    let settings = settings.unwrap_or_else(load_ai_settings);
    let candidates = ai_model_base_url_candidates(&settings.base_url);
    if candidates.is_empty() {
        return Err("AI Base URL is required.".to_string());
    }
    if settings.api_key.trim().is_empty() {
        return Err("AI API Key is required.".to_string());
    }

    let mut errors = Vec::new();
    for candidate in candidates {
        match list_models_from_base_url(&settings, &candidate).await {
            Ok(models) => {
                return Ok(AiModelListResponse {
                    base_url: candidate,
                    models,
                });
            }
            Err(error) => errors.push(format!("{}: {}", candidate, error)),
        }
    }

    Err(format!(
        "AI model list request failed. {}",
        errors.join(" | ")
    ))
}

#[tauri::command]
pub async fn run_ai_organizer(app: AppHandle, request: AiRunRequest) -> AiResult<AiRunResponse> {
    let settings = load_ai_settings();
    if settings.base_url.trim().is_empty()
        || settings.api_key.trim().is_empty()
        || settings.model.trim().is_empty()
    {
        return Err(
            "AI settings are incomplete. Configure Base URL, API Key, and Model first.".to_string(),
        );
    }

    let client = openai::CompletionsClient::builder()
        .api_key(settings.api_key.trim())
        .base_url(settings.base_url.trim())
        .build()
        .map_err(|e| format!("Create AI client: {}", e))?;

    let agent = client
        .agent(settings.model.trim())
        .name("Shelf AI")
        .tool_choice(ToolChoice::Auto)
        .default_max_turns(AI_MAX_TOOL_TURNS)
        .tool(ListMountedPathsTool)
        .tool(ListClaudeSessionsTool)
        .tool(ListCodexSessionsTool)
        .tool(SearchSessionRecordsTool)
        .tool(ReadFileLinesTool)
        .tool(ReplaceFileLinesTool)
        .build();

    let history = ai_history_to_messages(request.history);
    let mut stream = agent
        .stream_prompt(request.message)
        .with_history(history)
        .with_hook(AiStreamHook { app: app.clone() })
        .multi_turn(AI_MAX_TOOL_TURNS)
        .await;

    let mut message = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(text))) => {
                message.push_str(&text.text);
                emit_ai_event(&app, "text", None, Some(text.text), None);
            }
            Ok(MultiTurnStreamItem::StreamUserItem(StreamedUserContent::ToolResult {
                tool_result,
                internal_call_id,
            })) => {
                emit_ai_event(
                    &app,
                    "tool-result",
                    Some(internal_call_id),
                    Some(tool_result_to_text(&tool_result.content)),
                    None,
                );
            }
            Ok(MultiTurnStreamItem::FinalResponse(response)) => {
                if message.trim().is_empty() {
                    message = response.response().to_string();
                    if !message.is_empty() {
                        emit_ai_event(&app, "text", None, Some(message.clone()), None);
                    }
                }
            }
            Ok(_) => {}
            Err(error) => {
                let message = error.to_string();
                emit_ai_event(&app, "error", None, Some(message.clone()), None);
                return Err(format!("AI stream failed: {}", message));
            }
        }
    }
    emit_ai_event(&app, "done", None, None, None);

    Ok(AiRunResponse {
        message,
        map: load_ai_map(),
    })
}
