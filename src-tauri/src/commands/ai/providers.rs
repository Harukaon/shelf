use super::*;

pub(super) fn ai_model_base_url_candidates(base_url: &str) -> Vec<String> {
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

pub(super) fn claude_model_base_url_candidates(base_url: &str) -> Vec<String> {
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

pub(super) fn normalize_claude_base_url_input(base_url: &str) -> String {
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

pub(super) fn ai_models_endpoint(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

pub(super) fn normalized_bearer_token(api_key: &str) -> String {
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

pub(super) fn model_ids_from_response(value: Value) -> Vec<String> {
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

pub(super) fn model_ids_from_model_list(models: rig_core::model::ModelList) -> Vec<String> {
    let mut models = models
        .into_iter()
        .map(|model| model.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
}

pub(super) fn truncate_string(value: &str, max_chars: usize) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_base_url_normalization_accepts_api_roots_and_paths() {
        assert_eq!(
            normalize_claude_base_url_input(""),
            "https://api.anthropic.com"
        );
        assert_eq!(
            normalize_claude_base_url_input("https://api.anthropic.com/v1/messages"),
            "https://api.anthropic.com"
        );
        assert_eq!(
            normalize_claude_base_url_input("https://proxy.example.com/anthropic/v1"),
            "https://proxy.example.com/anthropic"
        );
        assert_eq!(
            claude_model_base_url_candidates("https://api.anthropic.com/v1/messages"),
            vec!["https://api.anthropic.com".to_string()]
        );
    }

    #[test]
    fn openai_base_url_candidates_keep_v1_fallback() {
        assert_eq!(
            ai_model_base_url_candidates("https://example.com/openai"),
            vec![
                "https://example.com/openai".to_string(),
                "https://example.com/openai/v1".to_string()
            ]
        );
        assert_eq!(
            ai_model_base_url_candidates("https://example.com/openai/v1/models"),
            vec!["https://example.com/openai/v1".to_string()]
        );
    }
}
