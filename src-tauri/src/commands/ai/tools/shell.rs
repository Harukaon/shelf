use super::super::*;

pub(crate) struct RunShellCommandTool;

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
