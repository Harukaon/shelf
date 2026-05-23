import type { SshTarget } from "../types";

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Snippet prepended to remote commands. Adds common install locations to
 * PATH so binaries like `claude` keep working even when the active nvm
 * version isn't the one they were installed in, or when ~/.local/bin etc.
 * aren't in the login shell's PATH.
 *
 * Idempotent (does not double-prepend paths already in PATH).
 */
const REMOTE_PATH_PRELUDE = [
  'for d in',
  '  "$HOME"/.nvm/versions/node/*/bin',
  '  "$HOME"/.fnm/node-versions/*/installation/bin',
  '  "$HOME"/.local/bin',
  '  "$HOME"/.npm-global/bin',
  '  "$HOME"/.bun/bin',
  '  "$HOME"/.cargo/bin',
  '  "$HOME"/.volta/bin',
  '; do',
  '  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH";; esac;',
  'done',
].join(' ');

/**
 * Build argv for spawning `ssh` to a target host.
 *
 * If a remote command is provided we wrap it in
 *   `bash -lc '<PATH bootstrap>; <cmd>'`
 *
 * so the remote login shell sources the user's profile (.bash_profile,
 * .bashrc, .zprofile, .zshrc, etc.) and then our snippet adds common
 * package-manager bin directories to PATH. Without this, ssh runs the
 * command through a non-interactive sh which has a minimal PATH, and even
 * with `-l` a command may live under an nvm version that isn't currently
 * active — both produce "command not found" for tools like `claude`,
 * `codex`, or anything installed via nvm / fnm / pnpm / bun / cargo.
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
    const wrapped = `${REMOTE_PATH_PRELUDE}; ${remoteCommand}`;
    args.push("--", `bash -lc ${shQuote(wrapped)}`);
  }
  return args;
}
