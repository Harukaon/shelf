use super::*;

pub(super) fn clamp_shell_timeout_ms(value: Option<u64>) -> u64 {
    value
        .unwrap_or(SHELL_DEFAULT_TIMEOUT_MS)
        .clamp(1_000, SHELL_MAX_TIMEOUT_MS)
}

pub(super) fn clamp_shell_max_bytes(value: Option<usize>) -> usize {
    value
        .unwrap_or(SHELL_DEFAULT_MAX_BYTES)
        .clamp(1_000, SHELL_MAX_OUTPUT_BYTES)
}

pub(super) fn clamp_shell_max_lines(value: Option<usize>) -> usize {
    value
        .unwrap_or(SHELL_DEFAULT_MAX_LINES)
        .clamp(20, SHELL_MAX_OUTPUT_LINES)
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ShellRiskPlatform {
    UnixLike,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ShellToken {
    Word(String),
    Separator,
}

pub(super) fn is_risky_shell_command(command: &str) -> bool {
    let platform = if cfg!(windows) {
        ShellRiskPlatform::Windows
    } else {
        ShellRiskPlatform::UnixLike
    };
    is_risky_shell_command_for_platform(command, platform)
}

pub(super) fn is_risky_shell_command_for_platform(
    command: &str,
    platform: ShellRiskPlatform,
) -> bool {
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

pub(super) fn shell_args_from_json(args: &str) -> RunShellCommandArgs {
    serde_json::from_str::<RunShellCommandArgs>(args).unwrap_or_default()
}

pub(super) fn shell_approval_payload(args: &RunShellCommandArgs) -> Value {
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

pub(super) async fn execute_shell_command(args: RunShellCommandArgs) -> Value {
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
}
