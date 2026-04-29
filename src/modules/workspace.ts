import { open } from "@tauri-apps/plugin-dialog";
import { tauriInvoke } from "../helpers";
import { WorkspaceItem, Session } from "../types";

export class WorkspaceManager {
  workspaces: WorkspaceItem[] = [];
  sessions = new Map<string, Session[]>();
  selectedWorkspace: string | null = null;
  expandedWorkspaces = new Set<string>();
  sessionPages = new Map<string, number>();

  constructor(
    private renderWorkspaces: () => void,
    private onSelectedChange?: (path: string | null) => void,
    private scanWorkspace?: (path: string) => Promise<void>,
  ) {}

  async load() {
    try {
      this.workspaces = await tauriInvoke<WorkspaceItem[]>("list_workspaces");
      this.renderWorkspaces();
    } catch (e) {
      console.warn("Tauri not available:", e);
      this.workspaces = [];
      this.renderWorkspaces();
    }
  }

  async promptAdd() {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select Workspace Folder" });
      if (selected && typeof selected === "string") await this.add(selected);
    } catch (e) {
      console.error("Folder picker:", e);
    }
  }

  async add(path: string) {
    try {
      const ws = await tauriInvoke<WorkspaceItem>("add_workspace", { path });
      this.workspaces.push(ws);
      this.renderWorkspaces();
    } catch (e) {
      console.error("Add workspace:", e);
    }
  }

  async remove(path: string) {
    try {
      await tauriInvoke("remove_workspace", { path });
      this.workspaces = this.workspaces.filter((w) => w.path !== path);
      this.sessions.delete(path);
      this.expandedWorkspaces.delete(path);
      this.sessionPages.delete(path);
      this.renderWorkspaces();
    } catch (e) {
      console.error("Remove workspace:", e);
    }
  }

  async select(newPath: string) {
    this.selectedWorkspace = newPath;
    this.expandedWorkspaces.add(newPath);
    if (!this.sessions.has(newPath)) {
      if (this.scanWorkspace) await this.scanWorkspace(newPath);
      else await this.scanSessions(newPath);
    }
    this.renderWorkspaces();
    if (this.onSelectedChange) this.onSelectedChange(newPath);
  }

  async scanSessions(workspacePath: string) {
    try {
      const sessions = await tauriInvoke<Session[]>("scan_sessions", { workspacePath });
      this.sessions.set(workspacePath, sessions);
    } catch (e) {
      console.error("Scan sessions:", e);
      this.sessions.set(workspacePath, []);
    }
  }

  getActiveSessionIds(): Set<string> {
    return new Set();
  }

  findWorkspaceForSession(sessionId: string): string | undefined {
    for (const [wsPath, sList] of this.sessions) {
      if (sList.some((s) => s.id === sessionId)) return wsPath;
    }
    return undefined;
  }

  getAllSessions(): { session: Session; workspacePath: string }[] {
    const all: { session: Session; workspacePath: string }[] = [];
    for (const [wsPath, sList] of this.sessions) {
      for (const s of sList) all.push({ session: s, workspacePath: wsPath });
    }
    return all;
  }
}
