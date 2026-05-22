use super::*;
use tauri::Emitter;

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
pub(super) async fn run_ai_organizer_with_settings(
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
