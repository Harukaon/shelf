use super::*;

pub(super) fn ai_history_to_messages(history: Vec<AiHistoryMessage>) -> Vec<Message> {
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
