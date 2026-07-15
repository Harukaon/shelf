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
use serde::Serialize;
use serde_json::{json, Value};
use std::future::Future;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tauri::AppHandle;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{sleep, Duration},
};
use url::Url;

mod history;
mod model_listing;
mod providers;
mod records;
mod runner;
mod shell;
mod storage;
mod tools;
mod types;

use history::*;
use model_listing::*;
use providers::*;
use records::*;
use runner::*;
use shell::*;
use storage::*;
use tools::*;
use types::*;
pub use types::{
    AiEndpoint, AiGroup, AiHistoryMessage, AiModelListResponse, AiRunRequest, AiRunResponse,
    AiSessionMap, AiSessionMeta, AiSettings, AiStreamEvent, RunShellCommandArgs,
};

type AiResult<T> = Result<T, String>;
const AI_STREAM_EVENT: &str = "shelf://ai-stream";
const AI_MAX_TOOL_TURNS: usize = 30;
const AI_MAX_COMPLETION_TOKENS: u64 = 4_096;
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

fn ai_cancel_requested() -> bool {
    AI_CANCEL_REQUESTED.load(Ordering::SeqCst)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_settings_defaults_legacy_json_to_openai_endpoint() {
        let settings: AiSettings = serde_json::from_str(
            r#"{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-test","model":"gpt-test"}"#,
        )
        .unwrap();

        assert_eq!(settings.endpoint, AiEndpoint::OpenAi);
        assert_eq!(settings.base_url, "https://api.openai.com/v1");
        assert_eq!(settings.api_key, "sk-test");
        assert_eq!(settings.model, "gpt-test");
    }
}
