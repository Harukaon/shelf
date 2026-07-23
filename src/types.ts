export type SessionProvider = "claude" | "codex" | "pi";

export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  password?: string;
}

export interface WorkspaceItem {
  name: string;
  path: string;
  provider: SessionProvider;
  session_count: number;
  ssh?: SshTarget;
}

export interface Session {
  id: string;
  cwd: string;
  display_title: string;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  message_count: number;
  started_at: string;
  updated_at: string;
  file_path: string;
  version: string;
  provider: SessionProvider;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileEntry[];
}

export interface TabInfo {
  id: string;
  sessionId?: string;
  sessionProvider?: SessionProvider;
  workspacePath?: string;
  cwd?: string;
  shell?: string;
  restoreKind?: "terminal" | "session" | "new-session";
  title: string;
  closable: boolean;
  terminal: import("@xterm/xterm").Terminal;
  fitAddon: import("@xterm/addon-fit").FitAddon;
  pty?: import("./modules/pty").IPty;
  ptyExited?: boolean;
  hasUnreadOutput?: boolean;
  containerEl: HTMLDivElement;
  active: boolean;
  resizeTimer?: ReturnType<typeof setTimeout>;
  ptyResizeTimer?: ReturnType<typeof setTimeout>;
  resizeFrame?: number;
  resizeFinalFrame?: number;
  resizeObserver?: ResizeObserver;
}

export interface AiSettings {
  endpoint: "openAi" | "claude";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiGroup {
  id: string;
  workspacePath: string;
  name: string;
  description?: string | null;
}

export interface AiSessionMeta {
  aliasTitle?: string | null;
  groupId?: string | null;
  tags: string[];
  summary?: string | null;
}

export interface AiSessionMap {
  version: number;
  groups: Record<string, AiGroup>;
  sessions: Record<string, AiSessionMeta>;
}

export interface AiRunResponse {
  message: string;
  map: AiSessionMap;
}

export type AiHistoryRole = "user" | "assistant" | "tool";

export interface AiHistoryMessage {
  role: AiHistoryRole;
  content: string;
  tool?: string | null;
}

export interface AiModelListResponse {
  baseUrl: string;
  models: string[];
}

export interface ShellCommandApproval {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
  maxLines: number;
  risk: "normal" | "dangerous";
}
