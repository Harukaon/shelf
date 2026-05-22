use crate::session::{Session, SessionProvider, ShelfConfig, Workspace};
use futures_util::StreamExt;
use rig_core::{
    agent::{HookAction, MultiTurnStreamItem, PromptHook, ToolCallHookAction},
    completion::{CompletionModel, GetTokenUsage, ToolDefinition},
    http_client::ReqwestClient,
    message::{Message, ToolChoice, ToolResultContent},
    prelude::{CompletionClient, ModelListingClient},
    providers::{anthropic, openai},
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
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{sleep, Duration},
};
use url::Url;

type AiResult<T> = Result<T, String>;
const AI_STREAM_EVENT: &str = "shelf://ai-stream";
const AI_MAX_TOOL_TURNS: usize = 30;
const AI_MAX_TOOL_RESULT_CHARS: usize = 24_000;
const AI_MAX_READ_FILE_LINES: usize = 400;
const SHELL_TOOL_NAME: &str = "run_shell_command";
const SHELL_APPROVAL_PREFIX: &str = "SHELF_SHELL_APPROVAL_REQUIRED:";
const SHELL_DEFAULT_TIMEOUT_MS: u64 = 8_000;
const SHELL_MAX_TIMEOUT_MS: u64 = 60_000;
const SHELL_DEFAULT_MAX_BYTES: usize = 30_000;
const SHELL_MAX_OUTPUT_BYTES: usize = 100_000;
const SHELL_DEFAULT_MAX_LINES: usize = 500;
const SHELL_MAX_OUTPUT_LINES: usize = 2_000;
const AI_CANCELLED_PREFIX: &str = "SHELF_AI_CANCELLED:";
const CLAUDE_DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
static AI_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
const AI_ORGANIZER_PREAMBLE: &str = r#"
You are Shelf's AI session organizer.

Your job is to classify existing Claude Code and Codex conversations into a flat list of AI Organizer categories.
Rules:
- Use categories as one-level labels only. Do not create nested folders or workspace structures.
- A mapping is only a reference to an original conversation: provider + sessionId + category metadata.
- Never delete original conversations. You do not have a tool that deletes conversations.
- Removing or moving mappings must only affect Shelf's AI organizer map.
- Session record editing is allowed only through mounted session ids. Use session-record tools with provider + sessionId; do not write arbitrary unmounted record files.
- Keep category names short and useful for a developer's sidebar.
- Prefer the existing conversation title as the display name. Do not create alias titles.
- Before mapping sessions, list mounted paths and list/search session records as needed.
"#;

#[derive(Debug, thiserror::Error)]
enum AiToolError {
    #[error("{0}")]
    Failed(String),
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum AiEndpoint {
    #[default]
    OpenAi,
    Claude,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSettings {
    pub endpoint: AiEndpoint,
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
    #[serde(default)]
    pub shell_auto_approve: bool,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadSessionRecordLinesArgs {
    provider: SessionProvider,
    session_id: String,
    start_line: usize,
    end_line: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceSessionRecordLinesArgs {
    provider: SessionProvider,
    session_id: String,
    start_line: usize,
    end_line: usize,
    replacement: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAiCategoryArgs {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameAiCategoryArgs {
    category_id: String,
    name: String,
    description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAiCategoryArgs {
    category_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddAiSessionMappingArgs {
    provider: SessionProvider,
    session_id: String,
    category_id: String,
    tags: Option<Vec<String>>,
    summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveAiSessionMappingArgs {
    provider: SessionProvider,
    session_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct RunShellCommandArgs {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    pub max_bytes: Option<usize>,
    pub max_lines: Option<usize>,
    pub approved: bool,
}

impl Default for RunShellCommandArgs {
    fn default() -> Self {
        Self {
            command: String::new(),
            cwd: None,
            timeout_ms: None,
            max_bytes: None,
            max_lines: None,
            approved: false,
        }
    }
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

fn claude_model_base_url_candidates(base_url: &str) -> Vec<String> {
    let base = normalize_claude_base_url_input(base_url);
    if base.is_empty() {
        return Vec::new();
    }

    vec![base]
}

fn normalize_ai_base_url_input(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    if let Some(prefix) = base.strip_suffix("/models") {
        base = prefix.to_string();
    }
    base
}

fn normalize_claude_base_url_input(base_url: &str) -> String {
    let base = if base_url.trim().is_empty() {
        CLAUDE_DEFAULT_BASE_URL
    } else {
        base_url.trim()
    };
    anthropic::client::normalize_anthropic_base_url(base)
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

fn model_ids_from_model_list(models: rig_core::model::ModelList) -> Vec<String> {
    let mut models = models
        .into_iter()
        .map(|model| model.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
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

fn clamp_shell_timeout_ms(value: Option<u64>) -> u64 {
    value
        .unwrap_or(SHELL_DEFAULT_TIMEOUT_MS)
        .clamp(1_000, SHELL_MAX_TIMEOUT_MS)
}

fn clamp_shell_max_bytes(value: Option<usize>) -> usize {
    value
        .unwrap_or(SHELL_DEFAULT_MAX_BYTES)
        .clamp(1_000, SHELL_MAX_OUTPUT_BYTES)
}

fn clamp_shell_max_lines(value: Option<usize>) -> usize {
    value
        .unwrap_or(SHELL_DEFAULT_MAX_LINES)
        .clamp(20, SHELL_MAX_OUTPUT_LINES)
}

#[derive(Debug, Clone, Copy)]
enum ShellRiskPlatform {
    UnixLike,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ShellToken {
    Word(String),
    Separator,
}

fn is_risky_shell_command(command: &str) -> bool {
    let platform = if cfg!(windows) {
        ShellRiskPlatform::Windows
    } else {
        ShellRiskPlatform::UnixLike
    };
    is_risky_shell_command_for_platform(command, platform)
}

fn is_risky_shell_command_for_platform(command: &str, platform: ShellRiskPlatform) -> bool {
    let mut segment = Vec::new();

    for token in shell_command_tokens(command) {
        match token {
            ShellToken::Word(word) => segment.push(word),
            ShellToken::Separator => {
                if shell_segment_is_risky(&segment, platform) {
                    return true;
                }
                segment.clear();
            }
        }
    }

    shell_segment_is_risky(&segment, platform)
}

fn shell_segment_is_risky(words: &[String], platform: ShellRiskPlatform) -> bool {
    let Some(command_index) = shell_command_word_index(words) else {
        return false;
    };
    let command = shell_command_name(&words[command_index]);

    if is_delete_command_name(&command, platform) {
        return true;
    }

    if let Some((script, script_platform)) =
        nested_shell_script(&command, &words[command_index + 1..], platform)
    {
        return is_risky_shell_command_for_platform(&script, script_platform);
    }

    false
}

fn shell_command_tokens(command: &str) -> Vec<ShellToken> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if let Some(quote_ch) = quote {
            if ch == '\\' && quote_ch != '\'' {
                escaped = true;
            } else if ch == quote_ch {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '\\' => escaped = true,
            ' ' | '\t' | '\r' => push_shell_word(&mut tokens, &mut current),
            '\n' | ';' | '|' | '&' | '(' | ')' => {
                push_shell_word(&mut tokens, &mut current);
                push_shell_separator(&mut tokens);
                if (ch == '|' || ch == '&') && chars.peek() == Some(&ch) {
                    chars.next();
                }
            }
            _ => current.push(ch),
        }
    }

    push_shell_word(&mut tokens, &mut current);
    tokens
}

fn push_shell_word(tokens: &mut Vec<ShellToken>, current: &mut String) {
    let word = current.trim();
    if !word.is_empty() {
        tokens.push(ShellToken::Word(word.to_string()));
    }
    current.clear();
}

fn push_shell_separator(tokens: &mut Vec<ShellToken>) {
    if !matches!(tokens.last(), Some(ShellToken::Separator)) {
        tokens.push(ShellToken::Separator);
    }
}

fn shell_command_word_index(words: &[String]) -> Option<usize> {
    let mut index = 0;

    while index < words.len() {
        while index < words.len() && is_shell_assignment(&words[index]) {
            index += 1;
        }
        if index >= words.len() {
            return None;
        }

        let command = shell_command_name(&words[index]);
        match command.as_str() {
            "sudo" | "doas" => {
                index += 1;
                while index < words.len() && words[index].starts_with('-') {
                    index += 1;
                }
            }
            "env" => {
                index += 1;
                while index < words.len()
                    && (words[index].starts_with('-') || is_shell_assignment(&words[index]))
                {
                    index += 1;
                }
            }
            "command" | "builtin" | "noglob" | "nohup" | "time" => index += 1,
            _ => return Some(index),
        }
    }

    None
}

fn is_shell_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn shell_command_name(command: &str) -> String {
    command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase()
}

fn is_delete_command_name(command: &str, platform: ShellRiskPlatform) -> bool {
    match platform {
        ShellRiskPlatform::UnixLike => command == "rm",
        ShellRiskPlatform::Windows => matches!(
            command,
            "del" | "erase" | "rd" | "rmdir" | "remove-item" | "rm" | "ri"
        ),
    }
}

fn nested_shell_script(
    command: &str,
    args: &[String],
    platform: ShellRiskPlatform,
) -> Option<(String, ShellRiskPlatform)> {
    if matches!(command, "cmd" | "cmd.exe") {
        return shell_script_after_flag(args, &["/c", "/k", "-c", "-k"])
            .map(|script| (script, ShellRiskPlatform::Windows));
    }

    if matches!(
        command,
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe"
    ) {
        return shell_script_after_flag(args, &["-command", "-c"])
            .map(|script| (script, ShellRiskPlatform::Windows));
    }

    if matches!(command, "sh" | "bash" | "zsh" | "fish") {
        return shell_script_after_flag(args, &["-c"]).map(|script| (script, platform));
    }

    None
}

fn shell_script_after_flag(args: &[String], flags: &[&str]) -> Option<String> {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].to_ascii_lowercase();
        if flags.iter().any(|flag| arg == *flag) {
            let script = args[index + 1..].join(" ");
            return (!script.trim().is_empty()).then_some(script);
        }
        index += 1;
    }
    None
}

fn shell_args_from_json(args: &str) -> RunShellCommandArgs {
    serde_json::from_str::<RunShellCommandArgs>(args).unwrap_or_default()
}

fn shell_approval_payload(args: &RunShellCommandArgs) -> Value {
    let command = args.command.trim().to_string();
    let cwd = args
        .cwd
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());
    json!({
        "command": command,
        "cwd": cwd,
        "timeoutMs": clamp_shell_timeout_ms(args.timeout_ms),
        "maxBytes": clamp_shell_max_bytes(args.max_bytes),
        "maxLines": clamp_shell_max_lines(args.max_lines),
        "risk": if is_risky_shell_command(&command) { "dangerous" } else { "normal" },
    })
}

fn ai_cancel_requested() -> bool {
    AI_CANCEL_REQUESTED.load(Ordering::SeqCst)
}

fn truncate_shell_output(value: &str, max_bytes: usize, max_lines: usize) -> (String, bool) {
    let mut used_bytes = 0usize;
    let mut used_lines = 0usize;
    let mut output = String::new();
    let mut truncated = false;

    for line in value.lines() {
        if used_lines >= max_lines {
            truncated = true;
            break;
        }

        let line_with_break = format!("{}\n", line);
        let line_bytes = line_with_break.len();
        if used_bytes + line_bytes > max_bytes {
            let remaining = max_bytes.saturating_sub(used_bytes);
            output.push_str(&String::from_utf8_lossy(
                &line_with_break.as_bytes()[..remaining],
            ));
            truncated = true;
            break;
        }

        output.push_str(&line_with_break);
        used_bytes += line_bytes;
        used_lines += 1;
    }

    if !value.is_empty() && output.is_empty() && max_bytes > 0 {
        output.push_str(&String::from_utf8_lossy(
            &value.as_bytes()[..value.len().min(max_bytes)],
        ));
        truncated = value.len() > max_bytes;
    }

    (output, truncated)
}

async fn execute_shell_command(args: RunShellCommandArgs) -> Value {
    let command = args.command.trim().to_string();
    let cwd = args
        .cwd
        .filter(|value| !value.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());
    let timeout_ms = clamp_shell_timeout_ms(args.timeout_ms);
    let max_bytes = clamp_shell_max_bytes(args.max_bytes);
    let max_lines = clamp_shell_max_lines(args.max_lines);
    let started = Instant::now();

    if command.is_empty() {
        return json!({
            "ok": false,
            "error": "command is required",
            "stdout": "",
            "stderr": "",
            "exitCode": null,
            "durationMs": 0,
            "truncated": false,
        });
    }

    let spawn_result = Command::new("zsh")
        .arg("-lc")
        .arg(&command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            return json!({
                "ok": false,
                "error": format!("spawn shell command: {}", error),
                "command": command,
                "cwd": cwd,
                "stdout": "",
                "stderr": "",
                "exitCode": null,
                "durationMs": started.elapsed().as_millis(),
                "truncated": false,
            });
        }
    };

    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let stdout_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer).await;
        buffer
    });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer).await;
        buffer
    });

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let (timed_out, cancelled) = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout_bytes = stdout_task.await.unwrap_or_default();
                let stderr_bytes = stderr_task.await.unwrap_or_default();
                let stdout_raw = String::from_utf8_lossy(&stdout_bytes).to_string();
                let stderr_raw = String::from_utf8_lossy(&stderr_bytes).to_string();
                let (stdout_text, stdout_truncated) =
                    truncate_shell_output(&stdout_raw, max_bytes, max_lines);
                let (stderr_text, stderr_truncated) =
                    truncate_shell_output(&stderr_raw, max_bytes, max_lines);
                return json!({
                    "ok": status.success(),
                    "command": command,
                    "cwd": cwd,
                    "stdout": stdout_text,
                    "stderr": stderr_text,
                    "exitCode": status.code(),
                    "durationMs": started.elapsed().as_millis(),
                    "timeoutMs": timeout_ms,
                    "maxBytes": max_bytes,
                    "maxLines": max_lines,
                    "stdoutBytes": stdout_raw.len(),
                    "stderrBytes": stderr_raw.len(),
                    "truncated": stdout_truncated || stderr_truncated,
                    "timedOut": false,
                });
            }
            Ok(None) => {
                if ai_cancel_requested() {
                    break (false, true);
                }
                if Instant::now() >= deadline {
                    break (true, false);
                }
                sleep(Duration::from_millis(100)).await;
            }
            Err(error) => {
                return json!({
                    "ok": false,
                    "error": format!("wait shell command: {}", error),
                    "command": command,
                    "cwd": cwd,
                    "stdout": "",
                    "stderr": "",
                    "exitCode": null,
                    "durationMs": started.elapsed().as_millis(),
                    "timeoutMs": timeout_ms,
                    "truncated": false,
                    "timedOut": false,
                });
            }
        }
    };

    if timed_out || cancelled {
        let _ = child.kill().await;
        let stdout_bytes = stdout_task.await.unwrap_or_default();
        let stderr_bytes = stderr_task.await.unwrap_or_default();
        let stdout_raw = String::from_utf8_lossy(&stdout_bytes).to_string();
        let stderr_raw = String::from_utf8_lossy(&stderr_bytes).to_string();
        let (stdout_text, _) = truncate_shell_output(&stdout_raw, max_bytes, max_lines);
        let (stderr_text, _) = truncate_shell_output(&stderr_raw, max_bytes, max_lines);
        return json!({
            "ok": false,
            "error": if cancelled { "command cancelled" } else { "command timed out" },
            "command": command,
            "cwd": cwd,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "exitCode": null,
            "durationMs": started.elapsed().as_millis(),
            "timeoutMs": timeout_ms,
            "maxBytes": max_bytes,
            "maxLines": max_lines,
            "stdoutBytes": stdout_raw.len(),
            "stderrBytes": stderr_raw.len(),
            "truncated": true,
            "timedOut": timed_out,
            "cancelled": cancelled,
        });
    }

    unreachable!("shell timeout branch should return")
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

async fn list_claude_models_from_base_url(
    settings: &AiSettings,
    base_url: &str,
) -> AiResult<Vec<String>> {
    let client = anthropic::Client::builder()
        .api_key(settings.api_key.trim())
        .base_url(base_url.trim())
        .build()
        .map_err(|e| format!("Create Claude client: {}", e))?;
    let models = client
        .list_models()
        .await
        .map_err(|e| format!("List Claude models: {}", e))?;
    let models = model_ids_from_model_list(models);
    if models.is_empty() {
        return Err("List Claude models: response did not contain any model ids.".to_string());
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

fn path_is_under(path: &Path, parent: &Path) -> bool {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    path.starts_with(parent)
}

fn is_ai_session_record_path(path: &Path) -> bool {
    let Some(home_dir) = dirs::home_dir() else {
        return false;
    };
    let claude_records_dir = home_dir.join(".claude").join("projects");
    let codex_records_dir = home_dir.join(".codex").join("sessions");
    path_is_under(path, &claude_records_dir) || path_is_under(path, &codex_records_dir)
}

fn provider_label(provider: SessionProvider) -> &'static str {
    match provider {
        SessionProvider::Claude => "Claude code",
        SessionProvider::Codex => "codex",
    }
}

fn provider_key(provider: SessionProvider) -> &'static str {
    match provider {
        SessionProvider::Claude => "claude",
        SessionProvider::Codex => "codex",
    }
}

fn mapped_session_key(provider: SessionProvider, session_id: &str) -> String {
    format!("{}:{}", provider_key(provider), session_id)
}

fn normalize_ai_tags(tags: Option<Vec<String>>) -> Vec<String> {
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

fn category_exists(category_id: &str, map: &AiSessionMap) -> Result<(), AiToolError> {
    if map.groups.contains_key(category_id) {
        Ok(())
    } else {
        Err(AiToolError::Failed(format!(
            "AI category '{}' does not exist",
            category_id
        )))
    }
}

fn mapped_session_exists(provider: SessionProvider, session_id: &str) -> bool {
    mounted_session(provider, session_id).is_ok()
}

fn mounted_session(provider: SessionProvider, session_id: &str) -> Result<Session, AiToolError> {
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

fn mounted_session_file(
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

fn read_record_lines(path: &Path) -> Result<Vec<String>, AiToolError> {
    fs::read_to_string(path)
        .map_err(|e| AiToolError::Failed(format!("Read file '{}': {}", path.display(), e)))
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

fn validate_session_record_lines(
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

fn replace_session_record_lines(
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
        if is_ai_session_record_path(Path::new(&args.file_path)) {
            return Err(AiToolError::Failed(
                "Use replace_session_record_lines with provider + sessionId to edit session records"
                    .to_string(),
            ));
        }
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

#[derive(Clone, Copy)]
struct ReadSessionRecordLinesTool;

impl Tool for ReadSessionRecordLinesTool {
    const NAME: &'static str = "read_session_record_lines";
    type Error = AiToolError;
    type Args = ReadSessionRecordLinesArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Read a mounted Claude/Codex session record by provider + sessionId and 1-based inclusive line range. This only reads sessions currently reachable from Shelf-mounted workspaces.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex"] },
                    "sessionId": { "type": "string" },
                    "startLine": { "type": "integer", "minimum": 1 },
                    "endLine": { "type": "integer", "minimum": 1 }
                },
                "required": ["provider", "sessionId", "startLine", "endLine"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let file_path = mounted_session_file(args.provider, &args.session_id)?;
        let lines = read_record_lines(&file_path)?;
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
            "provider": args.provider,
            "sessionId": args.session_id,
            "filePath": absolute_path_from_path(&file_path),
            "startLine": args.start_line,
            "endLine": args.end_line,
            "maxLinesPerRead": AI_MAX_READ_FILE_LINES,
            "lines": selected,
        })))
    }
}

#[derive(Clone, Copy)]
struct ReplaceSessionRecordLinesTool;

impl Tool for ReplaceSessionRecordLinesTool {
    const NAME: &'static str = "replace_session_record_lines";
    type Error = AiToolError;
    type Args = ReplaceSessionRecordLinesArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Replace a mounted Claude/Codex session record's 1-based inclusive line range by provider + sessionId. This directly edits the original conversation record, only for sessions currently reachable from Shelf-mounted workspaces. Replacement is rejected if it would make the JSONL record invalid.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex"] },
                    "sessionId": { "type": "string" },
                    "startLine": { "type": "integer", "minimum": 1 },
                    "endLine": { "type": "integer", "minimum": 1 },
                    "replacement": { "type": "string", "description": "Replacement text. Each non-empty replacement line must be valid JSONL." }
                },
                "required": ["provider", "sessionId", "startLine", "endLine", "replacement"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        replace_session_record_lines(
            args.provider,
            &args.session_id,
            args.start_line,
            args.end_line,
            &args.replacement,
        )
    }
}

#[derive(Clone, Copy)]
struct ListAiOrganizationTool;

impl Tool for ListAiOrganizationTool {
    const NAME: &'static str = "list_ai_session_organization";
    type Error = AiToolError;
    type Args = NoArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List Shelf's current AI organizer categories and session mappings. Mappings are lightweight references to original Claude/Codex sessions; they never copy or delete chat content.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        Ok(limited_json_output(json!(load_ai_map())))
    }
}

#[derive(Clone, Copy)]
struct CreateAiCategoryTool;

impl Tool for CreateAiCategoryTool {
    const NAME: &'static str = "create_ai_category";
    type Error = AiToolError;
    type Args = CreateAiCategoryArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Create one flat AI organizer category. Categories are not workspaces and cannot be nested.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Category name shown under AI Organizer." },
                    "description": { "type": "string", "description": "Optional short rationale for this category." }
                },
                "required": ["name"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let name = args.name.trim();
        if name.is_empty() {
            return Err(AiToolError::Failed("name is required".to_string()));
        }

        let mut map = load_ai_map();
        if let Some(existing) = map
            .groups
            .values()
            .find(|group| group.name.eq_ignore_ascii_case(name))
        {
            return Ok(limited_json_output(
                json!({ "category": existing, "created": false }),
            ));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let group = AiGroup {
            id: id.clone(),
            workspace_path: String::new(),
            name: name.to_string(),
            description: args.description.filter(|value| !value.trim().is_empty()),
        };
        map.groups.insert(id, group.clone());
        save_ai_map(&map).map_err(AiToolError::Failed)?;
        Ok(limited_json_output(
            json!({ "category": group, "created": true }),
        ))
    }
}

#[derive(Clone, Copy)]
struct RenameAiCategoryTool;

impl Tool for RenameAiCategoryTool {
    const NAME: &'static str = "rename_ai_category";
    type Error = AiToolError;
    type Args = RenameAiCategoryArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Rename or update the description for an AI organizer category. This does not modify any original conversation.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "categoryId": { "type": "string" },
                    "name": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["categoryId", "name"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let name = args.name.trim();
        if name.is_empty() {
            return Err(AiToolError::Failed("name is required".to_string()));
        }

        let mut map = load_ai_map();
        let category = map.groups.get_mut(&args.category_id).ok_or_else(|| {
            AiToolError::Failed(format!("AI category '{}' does not exist", args.category_id))
        })?;
        category.name = name.to_string();
        if let Some(description) = args.description {
            category.description = if description.trim().is_empty() {
                None
            } else {
                Some(description)
            };
        }
        let category = category.clone();
        save_ai_map(&map).map_err(AiToolError::Failed)?;
        Ok(limited_json_output(json!({ "category": category })))
    }
}

#[derive(Clone, Copy)]
struct DeleteAiCategoryTool;

impl Tool for DeleteAiCategoryTool {
    const NAME: &'static str = "delete_ai_category";
    type Error = AiToolError;
    type Args = DeleteAiCategoryArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Delete one AI organizer category and its mappings only. Original Claude/Codex conversations are never deleted.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "categoryId": { "type": "string" }
                },
                "required": ["categoryId"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut map = load_ai_map();
        let removed = map.groups.remove(&args.category_id).is_some();
        let before = map.sessions.len();
        map.sessions
            .retain(|_, meta| meta.group_id.as_deref() != Some(args.category_id.as_str()));
        let removed_mappings = before.saturating_sub(map.sessions.len());
        save_ai_map(&map).map_err(AiToolError::Failed)?;
        Ok(limited_json_output(json!({
            "removed": removed,
            "removedMappings": removed_mappings
        })))
    }
}

#[derive(Clone, Copy)]
struct AddAiSessionMappingTool;

impl Tool for AddAiSessionMappingTool {
    const NAME: &'static str = "add_ai_session_mapping";
    type Error = AiToolError;
    type Args = AddAiSessionMappingArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Add or move a lightweight mapping from an existing Claude/Codex conversation into one AI organizer category. This stores only provider + sessionId + category metadata; chat content stays in the original conversation.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex"] },
                    "sessionId": { "type": "string" },
                    "categoryId": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "summary": { "type": "string" }
                },
                "required": ["provider", "sessionId", "categoryId"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let session_id = args.session_id.trim();
        if session_id.is_empty() {
            return Err(AiToolError::Failed("sessionId is required".to_string()));
        }

        let mut map = load_ai_map();
        category_exists(&args.category_id, &map)?;
        if !mapped_session_exists(args.provider, session_id) {
            return Err(AiToolError::Failed(format!(
                "Session '{}' for provider '{}' is not mounted in Shelf",
                session_id,
                provider_key(args.provider)
            )));
        }

        let key = mapped_session_key(args.provider, session_id);
        map.sessions.insert(
            key.clone(),
            AiSessionMeta {
                alias_title: None,
                group_id: Some(args.category_id),
                tags: normalize_ai_tags(args.tags),
                summary: args.summary.filter(|value| !value.trim().is_empty()),
            },
        );
        save_ai_map(&map).map_err(AiToolError::Failed)?;
        Ok(limited_json_output(
            json!({ "sessionKey": key, "mapped": true }),
        ))
    }
}

#[derive(Clone, Copy)]
struct RemoveAiSessionMappingTool;

impl Tool for RemoveAiSessionMappingTool {
    const NAME: &'static str = "remove_ai_session_mapping";
    type Error = AiToolError;
    type Args = RemoveAiSessionMappingArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Remove one AI organizer mapping only. Original Claude/Codex conversation records remain untouched.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex"] },
                    "sessionId": { "type": "string" }
                },
                "required": ["provider", "sessionId"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let key = mapped_session_key(args.provider, args.session_id.trim());
        let mut map = load_ai_map();
        let removed = map.sessions.remove(&key).is_some();
        save_ai_map(&map).map_err(AiToolError::Failed)?;
        Ok(limited_json_output(
            json!({ "sessionKey": key, "removed": removed }),
        ))
    }
}

#[derive(Clone, Copy)]
struct RunShellCommandTool;

impl Tool for RunShellCommandTool {
    const NAME: &'static str = SHELL_TOOL_NAME;
    type Error = AiToolError;
    type Args = RunShellCommandArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Run a shell command in a background non-interactive zsh process. Use it for flexible local exploration such as rg/find/jq/sqlite3. Output is truncated by timeout, byte and line limits. Dangerous commands may require explicit user approval before execution.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run with zsh -lc." },
                    "cwd": { "type": "string", "description": "Working directory. Defaults to the user's home directory." },
                    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 60000 },
                    "maxBytes": { "type": "integer", "minimum": 1000, "maximum": 100000 },
                    "maxLines": { "type": "integer", "minimum": 20, "maximum": 2000 },
                    "approved": { "type": "boolean", "description": "Set true only when rerunning a command after the user clicked approval in Shelf." }
                },
                "required": ["command"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        Ok(execute_shell_command(args).await)
    }
}

#[derive(Clone)]
struct AiStreamHook {
    app: AppHandle,
    shell_auto_approve: bool,
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
            if ai_cancel_requested() {
                return ToolCallHookAction::terminate(format!(
                    "{}user requested stop",
                    AI_CANCELLED_PREFIX
                ));
            }
            emit_ai_event(&app, "tool-start", Some(id), Some(args), Some(tool));
            if tool_name == SHELL_TOOL_NAME {
                let shell_args = shell_args_from_json(_args);
                if !self.shell_auto_approve
                    && !shell_args.approved
                    && is_risky_shell_command(&shell_args.command)
                {
                    let payload = shell_approval_payload(&shell_args);
                    emit_ai_event(
                        &app,
                        "shell-approval",
                        Some(_internal_call_id.to_string()),
                        Some(payload.to_string()),
                        Some(tool_name.to_string()),
                    );
                    return ToolCallHookAction::terminate(format!(
                        "{}{}",
                        SHELL_APPROVAL_PREFIX, payload
                    ));
                }
            }
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
            if ai_cancel_requested() {
                return HookAction::terminate(format!(
                    "{}user requested stop",
                    AI_CANCELLED_PREFIX
                ));
            }
            emit_ai_event(&app, "tool-end", Some(id), Some(result), Some(tool));
            HookAction::cont()
        }
    }

    fn on_text_delta(
        &self,
        _text_delta: &str,
        _aggregated_text: &str,
    ) -> impl Future<Output = HookAction> + Send {
        async move {
            if ai_cancel_requested() {
                HookAction::terminate(format!("{}user requested stop", AI_CANCELLED_PREFIX))
            } else {
                HookAction::cont()
            }
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
pub fn stop_ai_organizer() -> AiResult<()> {
    AI_CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn execute_approved_shell_command(args: RunShellCommandArgs) -> AiResult<Value> {
    Ok(execute_shell_command(args).await)
}

#[tauri::command]
pub async fn list_ai_models(settings: Option<AiSettings>) -> AiResult<AiModelListResponse> {
    let settings = settings.unwrap_or_else(load_ai_settings);
    let candidates = match settings.endpoint {
        AiEndpoint::OpenAi => ai_model_base_url_candidates(&settings.base_url),
        AiEndpoint::Claude => claude_model_base_url_candidates(&settings.base_url),
    };
    if candidates.is_empty() {
        return Err("AI Base URL is required.".to_string());
    }
    if settings.api_key.trim().is_empty() {
        return Err("AI API Key is required.".to_string());
    }

    let mut errors = Vec::new();
    for candidate in candidates {
        let result = match settings.endpoint {
            AiEndpoint::OpenAi => list_models_from_base_url(&settings, &candidate).await,
            AiEndpoint::Claude => list_claude_models_from_base_url(&settings, &candidate).await,
        };
        match result {
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
    AI_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    let settings = load_ai_settings();
    if settings.api_key.trim().is_empty() || settings.model.trim().is_empty() {
        return Err(
            "AI settings are incomplete. Configure Endpoint, API Key, and Model first.".to_string(),
        );
    }

    if settings.endpoint == AiEndpoint::OpenAi && settings.base_url.trim().is_empty() {
        return Err(
            "AI settings are incomplete. Configure Base URL for OpenAI-compatible endpoint first."
                .to_string(),
        );
    }

    run_ai_organizer_with_settings(app, request, settings).await
}

async fn run_ai_organizer_with_settings(
    app: AppHandle,
    request: AiRunRequest,
    settings: AiSettings,
) -> AiResult<AiRunResponse> {
    match settings.endpoint {
        AiEndpoint::OpenAi => run_ai_organizer_openai(app, request, settings).await,
        AiEndpoint::Claude => run_ai_organizer_claude(app, request, settings).await,
    }
}

async fn run_ai_organizer_openai(
    app: AppHandle,
    request: AiRunRequest,
    settings: AiSettings,
) -> AiResult<AiRunResponse> {
    let client = openai::CompletionsClient::builder()
        .api_key(settings.api_key.trim())
        .base_url(settings.base_url.trim())
        .build()
        .map_err(|e| format!("Create AI client: {}", e))?;

    let agent = client
        .agent(settings.model.trim())
        .agent_with_shelf_tools()
        .build();

    stream_ai_organizer(app, request, agent).await
}

async fn run_ai_organizer_claude(
    app: AppHandle,
    request: AiRunRequest,
    settings: AiSettings,
) -> AiResult<AiRunResponse> {
    let base_url = normalize_claude_base_url_input(&settings.base_url);
    let client = anthropic::Client::builder()
        .api_key(settings.api_key.trim())
        .base_url(&base_url)
        .build()
        .map_err(|e| format!("Create Claude client: {}", e))?;

    let agent = client
        .agent(settings.model.trim())
        .agent_with_shelf_tools()
        .build();

    stream_ai_organizer(app, request, agent).await
}

trait ShelfAgentTools<M, P>
where
    M: CompletionModel,
    P: PromptHook<M>,
{
    fn agent_with_shelf_tools(
        self,
    ) -> rig_core::agent::AgentBuilder<M, P, rig_core::agent::WithBuilderTools>;
}

impl<M, P> ShelfAgentTools<M, P>
    for rig_core::agent::AgentBuilder<M, P, rig_core::agent::NoToolConfig>
where
    M: CompletionModel,
    P: PromptHook<M>,
{
    fn agent_with_shelf_tools(
        self,
    ) -> rig_core::agent::AgentBuilder<M, P, rig_core::agent::WithBuilderTools> {
        self.name("Shelf AI")
            .preamble(AI_ORGANIZER_PREAMBLE)
            .tool_choice(ToolChoice::Auto)
            .default_max_turns(AI_MAX_TOOL_TURNS)
            .tool(ListMountedPathsTool)
            .tool(ListClaudeSessionsTool)
            .tool(ListCodexSessionsTool)
            .tool(SearchSessionRecordsTool)
            .tool(ReadFileLinesTool)
            .tool(ReplaceFileLinesTool)
            .tool(ReadSessionRecordLinesTool)
            .tool(ReplaceSessionRecordLinesTool)
            .tool(ListAiOrganizationTool)
            .tool(CreateAiCategoryTool)
            .tool(RenameAiCategoryTool)
            .tool(DeleteAiCategoryTool)
            .tool(AddAiSessionMappingTool)
            .tool(RemoveAiSessionMappingTool)
            .tool(RunShellCommandTool)
    }
}

async fn stream_ai_organizer<M>(
    app: AppHandle,
    request: AiRunRequest,
    agent: rig_core::agent::Agent<M>,
) -> AiResult<AiRunResponse>
where
    M: CompletionModel + 'static,
    M::StreamingResponse: GetTokenUsage,
{
    let history = ai_history_to_messages(request.history);
    let mut stream = agent
        .stream_prompt(request.message)
        .with_history(history)
        .with_hook(AiStreamHook {
            app: app.clone(),
            shell_auto_approve: request.shell_auto_approve,
        })
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
                if message.contains(AI_CANCELLED_PREFIX) {
                    return Err(message);
                }
                if message.contains(SHELL_APPROVAL_PREFIX) {
                    return Err(message);
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_shell_risk_only_flags_rm_commands() {
        let platform = ShellRiskPlatform::UnixLike;

        assert!(is_risky_shell_command_for_platform("rm file.txt", platform));
        assert!(is_risky_shell_command_for_platform("rm -rf dist", platform));
        assert!(is_risky_shell_command_for_platform(
            "sudo rm -fr /tmp/demo",
            platform
        ));
        assert!(is_risky_shell_command_for_platform(
            "cd demo && rm -r build",
            platform
        ));
        assert!(is_risky_shell_command_for_platform(
            "bash -c 'rm -rf build'",
            platform
        ));

        assert!(!is_risky_shell_command_for_platform(
            "git reset --hard",
            platform
        ));
        assert!(!is_risky_shell_command_for_platform(
            "chmod -R 755 dist",
            platform
        ));
        assert!(!is_risky_shell_command_for_platform("mv old new", platform));
        assert!(!is_risky_shell_command_for_platform("cp a b", platform));
        assert!(!is_risky_shell_command_for_platform("echo rm", platform));
    }

    #[test]
    fn windows_shell_risk_flags_cmd_and_powershell_delete_commands() {
        let platform = ShellRiskPlatform::Windows;

        assert!(is_risky_shell_command_for_platform(
            "del /s /q build",
            platform
        ));
        assert!(is_risky_shell_command_for_platform(
            "rmdir /s /q dist",
            platform
        ));
        assert!(is_risky_shell_command_for_platform(
            "cmd /c del /s /q build",
            platform
        ));
        assert!(is_risky_shell_command_for_platform(
            "powershell -Command \"Remove-Item -Recurse -Force dist\"",
            platform
        ));
        assert!(is_risky_shell_command_for_platform(
            "pwsh -c 'rm -Recurse -Force dist'",
            platform
        ));

        assert!(!is_risky_shell_command_for_platform(
            "git reset --hard",
            platform
        ));
        assert!(!is_risky_shell_command_for_platform(
            "chmod -R 755 dist",
            platform
        ));
        assert!(!is_risky_shell_command_for_platform(
            "move old new",
            platform
        ));
        assert!(!is_risky_shell_command_for_platform("echo del", platform));
    }

    #[test]
    fn explicit_windows_shells_are_detected_on_unix_hosts() {
        let platform = ShellRiskPlatform::UnixLike;

        assert!(is_risky_shell_command_for_platform(
            "cmd /c rmdir /s /q dist",
            platform
        ));
        assert!(is_risky_shell_command_for_platform(
            "powershell -Command \"Remove-Item -Recurse -Force dist\"",
            platform
        ));
    }

    #[test]
    fn session_record_validation_accepts_valid_claude_jsonl_only() {
        let valid = vec![
            r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":"hello"}}"#
                .to_string(),
            r#"{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":"ok"}}"#
                .to_string(),
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
