use crate::session::SessionProvider;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, thiserror::Error)]
pub(crate) enum AiToolError {
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
pub(crate) struct NoArgs {}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MountedPathArgs {
    pub(crate) path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchSessionRecordsArgs {
    pub(crate) query: String,
    pub(crate) path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadFileLinesArgs {
    pub(crate) file_path: String,
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplaceFileLinesArgs {
    pub(crate) file_path: String,
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) replacement: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadSessionRecordLinesArgs {
    pub(crate) provider: SessionProvider,
    pub(crate) session_id: String,
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplaceSessionRecordLinesArgs {
    pub(crate) provider: SessionProvider,
    pub(crate) session_id: String,
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) replacement: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateAiCategoryArgs {
    pub(crate) name: String,
    pub(crate) description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameAiCategoryArgs {
    pub(crate) category_id: String,
    pub(crate) name: String,
    pub(crate) description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteAiCategoryArgs {
    pub(crate) category_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddAiSessionMappingArgs {
    pub(crate) provider: SessionProvider,
    pub(crate) session_id: String,
    pub(crate) category_id: String,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveAiSessionMappingArgs {
    pub(crate) provider: SessionProvider,
    pub(crate) session_id: String,
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
