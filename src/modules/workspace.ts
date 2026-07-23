import { open } from "@tauri-apps/plugin-dialog";
import { tauriInvoke } from "../helpers";
import { t } from "../i18n";
import { showToast } from "./toast";
import { WorkspaceItem, Session, SessionProvider, SshTarget } from "../types";
import { scanCommandForProvider } from "./cli-launch";

export class WorkspaceManager {
  workspaces: WorkspaceItem[] = [];
  sessions = new Map<string, Session[]>();
  selectedWorkspace: string | null = null;
  selectedProvider: SessionProvider | null = null;
  expandedProviders = new Set<SessionProvider>(["claude", "codex", "pi"]);
  expandedWorkspaces = new Set<string>();
  sessionPages = new Map<string, number>();

  constructor(
    private renderWorkspaces: () => void,
    private onSelectedChange?: (path: string | null) => void,
    private scanWorkspace?: (path: string, provider: SessionProvider, ssh?: SshTarget) => Promise<void>,
  ) {}

  workspaceKey(path: string, provider: SessionProvider): string {
    return `${provider}:${path}`;
  }

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

  async promptAdd(provider: SessionProvider) {
    let selected: string | string[] | null = null;
    try {
      selected = await open({ directory: true, multiple: false, title: "Select Workspace Folder" });
    } catch (e) {
      console.error("Folder picker:", e);
      return;
    }
    if (!selected || typeof selected !== "string") return;
    try {
      await this.add(selected, provider);
    } catch (e) {
      console.error("Add workspace failed:", e);
      showToast(t("toast.workspace_add_failed", String(e)), { variant: "error" });
    }
  }

  async add(path: string, provider: SessionProvider, ssh?: SshTarget) {
    const ws = await tauriInvoke<WorkspaceItem>("add_workspace", { path, provider, ssh });
    this.workspaces.push(ws);
    this.expandedProviders.add(provider);
    this.renderWorkspaces();
    return ws;
  }

  async remove(path: string, provider: SessionProvider, ssh?: SshTarget) {
    try {
      await tauriInvoke("remove_workspace", { path, provider, ssh });
      const key = this.workspaceKey(path, provider);
      this.workspaces = this.workspaces.filter((w) => !(w.path === path && w.provider === provider));
      this.sessions.delete(key);
      this.expandedWorkspaces.delete(key);
      this.sessionPages.delete(key);
      this.renderWorkspaces();
    } catch (e) {
      console.error("Remove workspace:", e);
      showToast(t("toast.workspace_remove_failed", String(e)), { variant: "error" });
    }
  }

  async select(path: string, provider: SessionProvider) {
    const key = this.workspaceKey(path, provider);
    this.selectedWorkspace = path;
    this.selectedProvider = provider;
    this.expandedProviders.add(provider);
    this.expandedWorkspaces.add(key);
    if (!this.sessions.has(key)) {
      if (this.scanWorkspace) await this.scanWorkspace(path, provider);
      else await this.scanSessions(path, provider);
    }
    this.renderWorkspaces();
    if (this.onSelectedChange) this.onSelectedChange(path);
  }

  async scanSessions(workspacePath: string, provider: SessionProvider, ssh?: SshTarget) {
    try {
      const command = scanCommandForProvider(provider);
      const sessions = await tauriInvoke<Session[]>(command, { workspacePath, ssh: ssh || null });
      this.sessions.set(this.workspaceKey(workspacePath, provider), sessions);
    } catch (e) {
      console.error("Scan sessions:", e);
      this.sessions.set(this.workspaceKey(workspacePath, provider), []);
    }
  }

  getSessions(workspacePath: string, provider: SessionProvider): Session[] {
    return this.sessions.get(this.workspaceKey(workspacePath, provider)) || [];
  }

  getActiveSessionIds(): Set<string> {
    return new Set();
  }

  findWorkspaceForSession(sessionId: string): string | undefined {
    for (const [key, sList] of this.sessions) {
      if (sList.some((s) => s.id === sessionId)) return key.slice(key.indexOf(":") + 1);
    }
    return undefined;
  }

  getAllSessions(): { session: Session; workspacePath: string }[] {
    const all: { session: Session; workspacePath: string }[] = [];
    for (const [key, sList] of this.sessions) {
      const workspacePath = key.slice(key.indexOf(":") + 1);
      for (const s of sList) all.push({ session: s, workspacePath });
    }
    return all;
  }

  get sshWorkspaces(): WorkspaceItem[] {
    return this.workspaces.filter((w) => w.ssh);
  }

  get localWorkspaces(): WorkspaceItem[] {
    return this.workspaces.filter((w) => !w.ssh);
  }
}
