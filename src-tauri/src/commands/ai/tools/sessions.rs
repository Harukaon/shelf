use super::super::*;

pub(crate) struct ListMountedPathsTool;

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
pub(crate) struct ListClaudeSessionsTool;

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
pub(crate) struct ListCodexSessionsTool;

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
pub(crate) struct ListPiSessionsTool;

impl Tool for ListPiSessionsTool {
    const NAME: &'static str = "list_pi_sessions";
    type Error = AiToolError;
    type Args = MountedPathArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List pi session records for a mounted local Shelf directory path. Use list_mounted_paths first to discover valid paths. Large outputs are truncated.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "A local directory path currently mounted for pi in Shelf's left sidebar." }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let sessions = scan_pi_sessions(&args.path)?;
        Ok(limited_json_output(json!({
            "path": absolute_path_string(&args.path),
            "provider": "pi",
            "sessions": sessions.into_iter().map(session_to_tool_value).collect::<Vec<_>>(),
        })))
    }
}

#[derive(Clone, Copy)]
pub(crate) struct SearchSessionRecordsTool;

impl Tool for SearchSessionRecordsTool {
    const NAME: &'static str = "search_session_records";
    type Error = AiToolError;
    type Args = SearchSessionRecordsArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search local Claude Code, Codex, and pi session files under Shelf-mounted directories. If path is omitted, searches every mounted directory. If path is provided, it must be a directory currently mounted in Shelf's left sidebar. Returns provider, session id, absolute filePath, line number, matched line, and --- separators. Output is truncated at a fixed limit; narrow the query or use read_file_lines with filePath and line numbers for details.".to_string(),
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
pub(crate) struct ReadFileLinesTool;

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
pub(crate) struct ReplaceFileLinesTool;

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
        let file_path = Path::new(&args.file_path);
        if is_ai_session_record_path(file_path) || is_pi_session_record_file(file_path) {
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
pub(crate) struct ReadSessionRecordLinesTool;

impl Tool for ReadSessionRecordLinesTool {
    const NAME: &'static str = "read_session_record_lines";
    type Error = AiToolError;
    type Args = ReadSessionRecordLinesArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Read a mounted Claude/Codex/pi session record by provider + sessionId and 1-based inclusive line range. This only reads local sessions currently reachable from Shelf-mounted workspaces.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex", "pi"] },
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
pub(crate) struct ReplaceSessionRecordLinesTool;

impl Tool for ReplaceSessionRecordLinesTool {
    const NAME: &'static str = "replace_session_record_lines";
    type Error = AiToolError;
    type Args = ReplaceSessionRecordLinesArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Replace a mounted Claude/Codex session record's 1-based inclusive line range by provider + sessionId. pi records are read-only. This directly edits the original conversation record, only for sessions currently reachable from Shelf-mounted workspaces. Replacement is rejected if it would make the JSONL record invalid.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex", "pi"] },
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
