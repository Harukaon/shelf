use crate::session::SshTarget;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SSH_CONNECT_TIMEOUT_SECS: u64 = 10;

/// A parsed entry from ~/.ssh/config
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshConfigEntry {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// SSH connection history entry, persisted in ~/.shelf/ssh_history.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshHistoryEntry {
    pub ssh: SshTarget,
    pub remote_path: String,
    pub last_connected: String,
}

/// Build the destination string (user@host or just host) for SSH.
fn ssh_dest(ssh: &SshTarget) -> String {
    match &ssh.user {
        Some(u) => format!("{}@{}", u, ssh.host),
        None => ssh.host.clone(),
    }
}

fn ssh_history_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".shelf")
        .join("ssh_history.json")
}

fn load_ssh_history() -> Vec<SshHistoryEntry> {
    let path = ssh_history_path();
    if !path.exists() {
        return Vec::new();
    }
    let content = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_ssh_history(history: &[SshHistoryEntry]) -> Result<(), String> {
    let path = ssh_history_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create shelf dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(history)
        .map_err(|e| format!("Failed to serialize ssh history: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write ssh history: {}", e))?;
    Ok(())
}

/// Build an `ssh` command with the given target's options.
/// Resulting argv: ssh [-p port] [-i identity] [-o options...] [user@]host
pub fn build_ssh_command(ssh: &SshTarget) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg(format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT_SECS));

    if let Some(port) = ssh.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(ref key) = ssh.identity_file {
        cmd.arg("-i").arg(key);
    }

    cmd.arg(ssh_dest(ssh));
    cmd
}

/// Execute a command on a remote host via SSH, capture stdout.
pub fn ssh_exec(ssh: &SshTarget, remote_command: &str) -> Result<String, String> {
    let mut cmd = build_ssh_command(ssh);
    cmd.arg("--").arg(remote_command);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute ssh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let code = output.status.code().map_or("".to_string(), |c| c.to_string());
        return Err(if stderr.is_empty() {
            format!("ssh exited with code {}", code)
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Build SSH args for an interactive PTY session (ssh -t).
/// Returns (program, args) tuple suitable for PTY spawn.
pub fn ssh_interactive_args(ssh: &SshTarget, remote_command: Option<&str>) -> (String, Vec<String>) {
    let mut args: Vec<String> = Vec::new();

    args.push("-o".to_string());
    args.push("StrictHostKeyChecking=accept-new".to_string());
    args.push("-o".to_string());
    args.push(format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT_SECS));
    args.push("-t".to_string());

    if let Some(port) = ssh.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    if let Some(ref key) = ssh.identity_file {
        args.push("-i".to_string());
        args.push(key.clone());
    }

    let dest = ssh_dest(ssh);
    args.push(dest);

    if let Some(cmd) = remote_command {
        args.push("--".to_string());
        args.push(cmd.to_string());
    }

    ("ssh".to_string(), args)
}

/// Test SSH connectivity by running `echo OK` on the remote host.
#[tauri::command]
pub async fn ssh_test_connection(ssh: SshTarget) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_exec(&ssh, "echo OK"))
        .await
        .map_err(|e| format!("SSH test failed: {}", e))?
}

/// Resolve a remote path (which may contain `~`, `..`, or be relative) to an
/// absolute, canonical path by running `cd <path> && pwd -P` on the remote.
#[tauri::command]
pub async fn ssh_resolve_path(ssh: SshTarget, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = path.trim();
        let target = if trimmed.is_empty() { "~" } else { trimmed };
        // Build a remote command that quotes safely while still letting the
        // remote shell expand a leading `~`. We translate:
        //   "~"           -> `cd && pwd -P`
        //   "~/foo bar"   -> `cd && cd 'foo bar' && pwd -P`
        //   "~user/foo"   -> `cd ~user/'foo' && pwd -P`   (left to shell)
        //   "/abs/path"   -> `cd '/abs/path' && pwd -P`
        //   "relative"    -> `cd 'relative' && pwd -P`
        let cmd = if target == "~" {
            "cd && pwd -P".to_string()
        } else if let Some(rest) = target.strip_prefix("~/") {
            let quoted_rest = rest.replace('\'', r"'\''");
            format!("cd && cd './{}' 2>/dev/null && pwd -P", quoted_rest)
        } else if let Some(rest) = target.strip_prefix('~') {
            // ~user form — leave the ~user prefix unquoted so the shell can
            // resolve the user, but quote the remainder.
            let (user, after_slash) = rest.split_once('/').unwrap_or((rest, ""));
            if after_slash.is_empty() {
                format!("cd ~{} 2>/dev/null && pwd -P", user)
            } else {
                let quoted_rest = after_slash.replace('\'', r"'\''");
                format!("cd ~{}/'{}' 2>/dev/null && pwd -P", user, quoted_rest)
            }
        } else {
            let quoted = target.replace('\'', r"'\''");
            format!("cd '{}' 2>/dev/null && pwd -P", quoted)
        };
        let result = ssh_exec(&ssh, &cmd)?;
        if result.is_empty() {
            return Err(format!("Cannot resolve remote path '{}'", target));
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("SSH resolve failed: {}", e))?
}

/// Parse ~/.ssh/config and return host entries with full details.
#[tauri::command]
pub fn ssh_list_config_hosts() -> Result<Vec<SshConfigEntry>, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let config_path = home.join(".ssh").join("config");

    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let content =
        fs::read_to_string(&config_path).map_err(|e| format!("Read ssh config: {}", e))?;

    Ok(parse_ssh_config(&content))
}

fn parse_ssh_config(content: &str) -> Vec<SshConfigEntry> {
    let mut entries: Vec<SshConfigEntry> = Vec::new();
    let mut current: Option<SshConfigEntry> = None;
    let mut current_aliases: Vec<String> = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(2, |c: char| c.is_whitespace()).collect();
        if parts.len() < 2 {
            continue;
        }
        let keyword = parts[0].to_lowercase();
        let value = parts[1].trim();

        match keyword.as_str() {
            "host" => {
                // Flush previous entry
                if let Some(entry) = current.take() {
                    for alias in current_aliases.drain(..) {
                        entries.push(SshConfigEntry {
                            alias,
                            host_name: entry.host_name.clone(),
                            user: entry.user.clone(),
                            port: entry.port,
                            identity_file: entry.identity_file.clone(),
                        });
                    }
                }
                // Start new entries for each alias
                for alias in value.split_whitespace() {
                    if !alias.contains('*') && !alias.contains('?') {
                        current_aliases.push(alias.to_string());
                    }
                }
                current = Some(SshConfigEntry {
                    alias: String::new(),
                    host_name: None,
                    user: None,
                    port: None,
                    identity_file: None,
                });
            }
            "hostname" => {
                if let Some(ref mut entry) = current {
                    entry.host_name = Some(value.to_string());
                }
            }
            "user" => {
                if let Some(ref mut entry) = current {
                    entry.user = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(ref mut entry) = current {
                    entry.port = value.parse().ok();
                }
            }
            "identityfile" => {
                if let Some(ref mut entry) = current {
                    let expanded = if value.starts_with("~/") {
                        if let Some(home) = dirs::home_dir() {
                            format!("{}{}", home.to_string_lossy(), &value[1..])
                        } else {
                            value.to_string()
                        }
                    } else {
                        value.to_string()
                    };
                    entry.identity_file = Some(expanded);
                }
            }
            _ => {}
        }
    }

    // Flush last entry
    if let Some(entry) = current.take() {
        for alias in current_aliases {
            entries.push(SshConfigEntry {
                alias,
                host_name: entry.host_name.clone(),
                user: entry.user.clone(),
                port: entry.port,
                identity_file: entry.identity_file.clone(),
            });
        }
    }

    entries
}

/// Get SSH connection history.
#[tauri::command]
pub fn ssh_get_history() -> Result<Vec<SshHistoryEntry>, String> {
    Ok(load_ssh_history())
}

/// Add or update an SSH connection history entry.
#[tauri::command]
pub fn ssh_add_history(ssh: SshTarget, remote_path: String) -> Result<(), String> {
    let mut history = load_ssh_history();

    // Remove existing entry for same host+path
    history.retain(|entry| {
        !(entry.ssh.host == ssh.host
            && entry.remote_path == remote_path
            && entry.ssh.port == ssh.port)
    });

    // Add new entry at the front
    history.insert(
        0,
        SshHistoryEntry {
            ssh,
            remote_path,
            last_connected: chrono::Utc::now().to_rfc3339(),
        },
    );

    // Keep at most 50 entries
    history.truncate(50);

    save_ssh_history(&history)
}

/// Find a command (e.g. claude, codex) on a remote host via SSH.
#[tauri::command]
pub fn ssh_find_command(ssh: SshTarget, command_name: String) -> Result<String, String> {
    let remote_cmd = format!(
        "command -v {} 2>/dev/null || which {} 2>/dev/null",
        command_name, command_name
    );
    let result = ssh_exec(&ssh, &remote_cmd)?;
    if result.is_empty() {
        Err(format!("{} not found on remote host", command_name))
    } else {
        Ok(result)
    }
}