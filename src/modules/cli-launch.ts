import type { SessionProvider } from "../types";
import { shQuote } from "./ssh";

export type CliCommand = {
  bin: string;
  args: string[];
};

/**
 * Parse a shell-like argument string into argv without invoking a shell.
 *
 * Supports single/double quotes and escaped whitespace. Backslashes that are
 * part of ordinary Windows paths are preserved instead of being treated as
 * escapes unconditionally.
 */
export function parseCliArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (char === "\\" && quote === '"' && index + 1 < input.length) {
        const next = input[index + 1];
        if (next === '"' || next === "\\" || /\s/.test(next)) {
          current += next;
          tokenStarted = true;
          index++;
          continue;
        }
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    if (char === "\\" && index + 1 < input.length) {
      const next = input[index + 1];
      if (/\s/.test(next) || next === "'" || next === '"' || next === "\\") {
        current += next;
        tokenStarted = true;
        index++;
        continue;
      }
    }
    current += char;
    tokenStarted = true;
  }

  if (quote) throw new Error("unclosed quote");
  if (tokenStarted) args.push(current);
  return args;
}

function formatCliArg(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatCliArgs(args: string[]): string {
  return args.map(formatCliArg).join(" ");
}

/** Human-readable shell-style representation of the argv passed to the PTY. */
export function formatCliCommand(command: CliCommand): string {
  return formatCliArgs([command.bin, ...command.args]);
}

export function buildCliArgs(
  provider: SessionProvider,
  extraArgs: string[],
  cwd: string,
  sessionId?: string,
): string[] {
  let managedArgs: string[];
  switch (provider) {
    case "claude":
      managedArgs = sessionId ? ["--resume", sessionId] : [];
      break;
    case "codex":
      managedArgs = sessionId
        ? ["resume", sessionId, "-C", cwd]
        : ["-C", cwd];
      break;
    case "pi":
      managedArgs = sessionId ? ["--session", sessionId] : [];
      break;
    default:
      return assertNever(provider);
  }
  return [...extraArgs, ...managedArgs];
}

export function defaultCliBin(provider: SessionProvider): string {
  switch (provider) {
    case "claude": return "claude";
    case "codex": return "codex";
    case "pi": return "pi";
    default: return assertNever(provider);
  }
}

export function scanCommandForProvider(provider: SessionProvider): string {
  switch (provider) {
    case "claude": return "scan_sessions";
    case "codex": return "scan_codex_sessions";
    case "pi": return "scan_pi_sessions";
    default: return assertNever(provider);
  }
}

export function buildLocalCliCommand(
  provider: SessionProvider,
  bin: string,
  extraArgs: string[],
  cwd: string,
  sessionId?: string,
): CliCommand {
  return { bin, args: buildCliArgs(provider, extraArgs, cwd, sessionId) };
}

export function buildRemoteCliCommand(
  provider: SessionProvider,
  extraArgs: string[],
  cwd: string,
  sessionId?: string,
): string {
  const command = [defaultCliBin(provider), ...buildCliArgs(provider, extraArgs, cwd, sessionId)]
    .map(shQuote)
    .join(" ");
  if (provider !== "pi") return command;
  return `${remoteCdCommand(cwd)} && ${command}`;
}

function remoteCdCommand(cwd: string): string {
  const path = cwd.trim();
  if (!path || path === "~") return "cd";
  if (path.startsWith("~/")) return `cd && cd -- ${shQuote(path.slice(2))}`;
  return `cd -- ${shQuote(path)}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported session provider: ${String(value)}`);
}
