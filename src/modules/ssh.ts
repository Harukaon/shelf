import type { SshTarget } from "../types";

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build argv for spawning `ssh` to a target host.
 *
 * If a remote command is provided we wrap it in `bash -lc '<cmd>'` so the
 * remote login shell sources the user's profile (.bash_profile, .bashrc,
 * .zprofile, .zshrc, etc.). Without this, ssh runs the command through a
 * non-interactive sh, which skips PATH-modifying lines — that's the usual
 * reason commands like `claude`, `codex`, or anything installed via nvm,
 * fnm, asdf, or ~/.local/bin "can't be found" on the remote.
 */
export function buildSshArgs(ssh: SshTarget, remoteCommand?: string): string[] {
  const args: string[] = [];
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", "ConnectTimeout=10");
  args.push("-t");
  if (ssh.port) args.push("-p", String(ssh.port));
  if (ssh.identityFile) args.push("-i", ssh.identityFile);
  const dest = ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
  args.push(dest);
  if (remoteCommand) {
    args.push("--", `bash -lc ${shQuote(remoteCommand)}`);
  }
  return args;
}
