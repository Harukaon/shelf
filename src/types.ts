export interface WorkspaceItem {
  name: string;
  path: string;
  session_count: number;
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
  workspacePath?: string;
  title: string;
  closable: boolean;
  terminal: import("@xterm/xterm").Terminal;
  fitAddon: import("@xterm/addon-fit").FitAddon;
  pty?: import("./modules/pty").IPty;
  containerEl: HTMLDivElement;
  dataBuffer: Uint8Array[];
  active: boolean;
  resizeTimer?: ReturnType<typeof setTimeout>;
  ptyResizeTimer?: ReturnType<typeof setTimeout>;
  resizeFrame?: number;
  resizeFinalFrame?: number;
  resizeObserver?: ResizeObserver;
}
