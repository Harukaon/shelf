use super::super::*;

pub(crate) struct ListAiOrganizationTool;

impl Tool for ListAiOrganizationTool {
    const NAME: &'static str = "list_ai_session_organization";
    type Error = AiToolError;
    type Args = NoArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List Shelf's current AI organizer categories and session mappings. Mappings are lightweight references to original Claude/Codex/pi sessions; they never copy or delete chat content.".to_string(),
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
pub(crate) struct CreateAiCategoryTool;

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
pub(crate) struct RenameAiCategoryTool;

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
pub(crate) struct DeleteAiCategoryTool;

impl Tool for DeleteAiCategoryTool {
    const NAME: &'static str = "delete_ai_category";
    type Error = AiToolError;
    type Args = DeleteAiCategoryArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Delete one AI organizer category and its mappings only. Original Claude/Codex/pi conversations are never deleted.".to_string(),
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
pub(crate) struct AddAiSessionMappingTool;

impl Tool for AddAiSessionMappingTool {
    const NAME: &'static str = "add_ai_session_mapping";
    type Error = AiToolError;
    type Args = AddAiSessionMappingArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Add or move a lightweight mapping from an existing Claude/Codex/pi conversation into one AI organizer category. This stores only provider + sessionId + category metadata; chat content stays in the original conversation.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex", "pi"] },
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
pub(crate) struct RemoveAiSessionMappingTool;

impl Tool for RemoveAiSessionMappingTool {
    const NAME: &'static str = "remove_ai_session_mapping";
    type Error = AiToolError;
    type Args = RemoveAiSessionMappingArgs;
    type Output = Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Remove one AI organizer mapping only. Original Claude/Codex/pi conversation records remain untouched.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": ["claude", "codex", "pi"] },
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
