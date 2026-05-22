use super::*;

pub(super) fn limited_json_output(value: Value) -> Value {
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

pub(super) async fn list_models_from_base_url(
    settings: &AiSettings,
    base_url: &str,
) -> AiResult<Vec<String>> {
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

pub(super) async fn list_claude_models_from_base_url(
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
