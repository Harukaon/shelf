import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "tauri-pty";
import { open } from "@tauri-apps/plugin-dialog";
import { createIcons, Folder, FolderOpen, File, ChevronRight, Plus, X, Circle, CircleDot, MessageSquare, Search } from "lucide";
import "@xterm/xterm/css/xterm.css";

const ICONS = { Folder, FolderOpen, File, ChevronRight, Plus, X, Circle, CircleDot, MessageSquare, Search };

function refreshIcons(el?: HTMLElement) {
  createIcons({
    icons: ICONS,
    attrs: { stroke: "currentColor", width: "14", height: "14", "stroke-width": "1.5" },
  });
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
  }
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return Promise.reject(new Error("Tauri API not available"));
  return tauri.core.invoke<T>(cmd, args);
}

interface WorkspaceItem { name: string; path: string; session_count: number; }
interface Session { id: string; cwd: string; display_title: string; custom_title: string | null; ai_title: string | null; first_prompt: string | null; message_count: number; started_at: string; version: string; }
interface FileEntry { name: string; path: string; is_dir: boolean; children: FileEntry[]; }
interface TabInfo { id: string; sessionId?: string; title: string; terminal: Terminal; fitAddon: FitAddon; pty?: IPty; containerEl: HTMLDivElement; }

class App {
  private tabs = new Map<string, TabInfo>();
  private activeTabId: string | null = null;
  private workspaces: WorkspaceItem[] = [];
  private selectedWorkspace: string | null = null;
  private sessions = new Map<string, Session[]>();
  private expandedWorkspaces = new Set<string>();
  private activeSessionIds = new Set<string>();
  private expandedDirs = new Set<string>();
  private lastFileTree: FileEntry[] = [];

  private tabList!: HTMLElement;
  private tabAddBtn!: HTMLElement;
  private workspaceList!: HTMLElement;
  private addWorkspaceBtn!: HTMLElement;
  private fileTree!: HTMLElement;
  private terminalContainer!: HTMLElement;

  async init() {
    this.tabList = document.getElementById("tab-list")!;
    this.tabAddBtn = document.getElementById("tab-add-btn")!;
    this.workspaceList = document.getElementById("workspace-list")!;
    this.addWorkspaceBtn = document.getElementById("add-workspace-btn")!;
    this.fileTree = document.getElementById("file-tree")!;
    this.terminalContainer = document.getElementById("terminal-container")!;

    this.setupEventListeners();
    this.setupDragDrop();
    await this.loadWorkspaces();
    await this.createEmptyTab();
  }

  private setupEventListeners() {
    this.tabAddBtn.addEventListener("click", () => this.onTabAddClick());
    this.addWorkspaceBtn.addEventListener("click", () => this.promptAddWorkspace());
    window.addEventListener("resize", () => {
      this.tabs.forEach((tab) => { try { tab.fitAddon.fit(); } catch (_) {} });
    });
  }

  private setupDragDrop() {
    // Only block default on terminal and workspace areas (not whole document)
    const dropTargets: Array<{ el: HTMLElement; handler: (path: string) => void; label: string }> = [
      {
        el: this.terminalContainer,
        label: "terminal",
        handler: (path: string) => {
          if (this.activeTabId) {
            const tab = this.tabs.get(this.activeTabId);
            if (tab?.pty) {
              tab.pty.write(`"${path}" `);
              console.log("[Shelf] drop: wrote to terminal:", path);
            }
          }
        },
      },
      {
        el: this.workspaceList,
        label: "workspaceList",
        handler: (path: string) => {
          console.log("[Shelf] drop: adding workspace:", path);
          this.addWorkspace(path);
        },
      },
    ];

    dropTargets.forEach(({ el, handler, label }) => {
      el.addEventListener("dragover", (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        el.classList.add("drag-over");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
      el.addEventListener("drop", (e: DragEvent) => {
        e.preventDefault();
        el.classList.remove("drag-over");
        console.log("[Shelf] drop on", label);

        // Try custom data (set by file tree dragstart) first
        const customPath = e.dataTransfer?.getData("text/plain");
        if (customPath) {
          console.log("[Shelf] drop custom path:", customPath);
          handler(customPath);
          return;
        }

        // Fallback: Finder drag files
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          const file = files[0] as unknown as { path?: string };
          if (file?.path) handler(file.path);
        }
      });
    });
  }

  // ─── Workspace ───

  private async loadWorkspaces() {
    try {
      this.workspaces = await tauriInvoke<WorkspaceItem[]>("list_workspaces");
      this.renderWorkspaces();
    } catch (e) {
      console.warn("Tauri not available:", e);
      this.workspaces = [];
      this.renderWorkspaces();
    }
  }

  private async promptAddWorkspace() {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select Workspace Folder" });
      if (selected && typeof selected === "string") this.addWorkspace(selected);
    } catch (e) { console.error("Folder picker:", e); }
  }

  private async addWorkspace(path: string) {
    try {
      const ws = await tauriInvoke<WorkspaceItem>("add_workspace", { path });
      this.workspaces.push(ws);
      this.renderWorkspaces();
    } catch (e) { console.error("Add workspace:", e); alert(`Failed: ${e}`); }
  }

  private async removeWorkspace(path: string) {
    try {
      await tauriInvoke("remove_workspace", { path });
      this.workspaces = this.workspaces.filter(w => w.path !== path);
      this.sessions.delete(path);
      this.expandedWorkspaces.delete(path);
      if (this.selectedWorkspace === path) {
        this.selectedWorkspace = null;
        this.fileTree.innerHTML = '<div class="tree-empty">No workspace selected</div>';
      }
      this.renderWorkspaces();
    } catch (e) { console.error("Remove workspace:", e); }
  }

  private async selectWorkspace(path: string) {
    this.selectedWorkspace = path;
    this.expandedWorkspaces.add(path);
    if (!this.sessions.has(path)) await this.scanSessions(path);
    await this.loadFileTree(path);
    this.renderWorkspaces();
  }

  private async scanSessions(workspacePath: string) {
    try {
      const sessions = await tauriInvoke<Session[]>("scan_sessions", { workspacePath });
      this.sessions.set(workspacePath, sessions);
    } catch (e) {
      console.error("Scan sessions:", e);
      this.sessions.set(workspacePath, []);
    }
  }

  private async loadFileTree(path: string) {
    try {
      const files = await tauriInvoke<FileEntry[]>("list_files", { path });
      console.log("[Shelf] loadFileTree got", files.length, "root entries");
      console.log("[Shelf] first entry:", JSON.stringify(files[0] || "none"));
      this.expandedDirs.clear();
      this.lastFileTree = files;
      this.renderFileTree(files);
    } catch (e) {
      console.error("List files:", e);
      this.fileTree.innerHTML = '<div class="tree-empty">Failed to load files</div>';
    }
  }

  // ─── Tab management ───

  private async createEmptyTab(): Promise<string> {
    const tabId = crypto.randomUUID();
    const tab = this.createTerminalTab(tabId, "Terminal");
    this.tabs.set(tabId, tab);
    this.activateTab(tabId);
    return tabId;
  }

  private async createSessionTab(session: Session, workspacePath: string): Promise<string> {
    for (const [id, tab] of this.tabs) {
      if (tab.sessionId === session.id) { this.activateTab(id); return id; }
    }
    const tabId = crypto.randomUUID();
    const cwd = session.cwd || workspacePath;
    const tab = this.createTerminalTab(tabId, session.display_title, session.id, cwd);
    this.tabs.set(tabId, tab);
    this.activateTab(tabId);
    setTimeout(() => { this.writeToTab(tabId, `claude --resume ${session.id}\n`); }, 600);
    this.activeSessionIds.add(session.id);
    return tabId;
  }

  private getShell(): string {
    const plat = navigator.platform?.toLowerCase() || "";
    if (plat.includes("win")) return "powershell.exe";
    return "zsh";
  }

  private createTerminalTab(tabId: string, title: string, sessionId?: string, cwd?: string): TabInfo {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", "Menlo", monospace',
      theme: {
        background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
        selectionBackground: "#45475a",
        black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
        blue: "#89b4fa", magenta: "#cba6f7", cyan: "#94e2d5", white: "#bac2de",
        brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#cba6f7",
        brightCyan: "#94e2d5", brightWhite: "#a6adc8",
      },
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    let pty: IPty | undefined;
    try {
      const spawnOpts: Record<string, unknown> = { cols: terminal.cols, rows: terminal.rows };
      if (cwd) spawnOpts.cwd = cwd;
      pty = spawn(this.getShell(), [], spawnOpts);
      pty.onData((data: Uint8Array) => { terminal.write(data); });
      terminal.onData((data: string) => { this.writeToPty(tabId, data); });
      pty.onExit(() => { terminal.write("\r\n[Process exited]\r\n"); });
    } catch (e) {
      console.error("Spawn PTY:", e);
      terminal.write(`\r\n[Failed to start shell: ${e}]\r\n`);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "terminal-wrapper";
    wrapper.dataset.tabId = tabId;
    wrapper.style.cssText = "width:100%;height:100%;display:none;";
    terminal.open(wrapper);
    this.terminalContainer.appendChild(wrapper);

    const isFirst = !this.activeTabId;
    if (isFirst) { wrapper.style.display = "block"; fitAddon.fit(); }

    terminal.onResize(({ cols, rows }) => {
      const tab = this.tabs.get(tabId);
      if (tab?.pty) { try { tab.pty.resize(cols, rows); } catch (_) {} }
    });

    return { id: tabId, sessionId, title, terminal, fitAddon, pty, containerEl: wrapper };
  }

  private writeToPty(tabId: string, data: string) {
    const tab = this.tabs.get(tabId);
    if (tab?.pty) { try { tab.pty.write(data); } catch (_) {} }
  }

  private writeToTab(tabId: string, data: string) {
    const tab = this.tabs.get(tabId);
    if (tab?.pty) { try { tab.pty.write(data); } catch (_) {} }
  }

  private activateTab(tabId: string) {
    if (this.activeTabId === tabId) return;
    this.tabs.forEach(t => { t.containerEl.style.display = "none"; });
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.containerEl.style.display = "block";
      tab.fitAddon.fit();
      tab.terminal.focus();
    }
    this.activeTabId = tabId;
    this.renderTabs();
    this.renderWorkspaces();
  }

  private closeTab(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.pty) { try { tab.pty.kill(); } catch (_) {} }
    tab.terminal.dispose();
    tab.containerEl.remove();
    if (tab.sessionId) this.activeSessionIds.delete(tab.sessionId);
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.activateTab(remaining[remaining.length - 1]);
      } else {
        this.activeTabId = null;
        this.terminalContainer.innerHTML = '<div class="terminal-placeholder">Click a session or + to open a terminal</div>';
      }
    }
    this.renderTabs();
    this.renderWorkspaces();
  }

  private onTabAddClick() { this.showSessionPicker(); }

  private showSessionPicker() {
    const allSessions: { session: Session; workspacePath: string }[] = [];
    for (const [wsPath, sessions] of this.sessions) {
      for (const s of sessions) allSessions.push({ session: s, workspacePath: wsPath });
    }
    if (allSessions.length === 0) { this.createEmptyTab(); return; }

    const picker = document.createElement("div");
    picker.className = "session-picker";
    picker.innerHTML = `<div class="picker-search"><i data-lucide="search"></i><input placeholder="Search sessions..." autofocus></div><div class="picker-list"></div>`;
    document.body.appendChild(picker);
    refreshIcons();

    const input = picker.querySelector("input")!;
    const list = picker.querySelector(".picker-list")!;

    const renderFiltered = (filter: string) => {
      list.innerHTML = "";
      const filtered = allSessions.filter(({ session }) =>
        session.display_title.toLowerCase().includes(filter.toLowerCase()));
      if (filtered.length === 0) {
        list.innerHTML = '<div class="picker-empty">No sessions found</div>';
        return;
      }
      for (const { session, workspacePath } of filtered.slice(0, 20)) {
        const item = document.createElement("div");
        item.className = "picker-item";
        item.innerHTML = `<i data-lucide="message-square"></i><span class="picker-title">${escapeHtml(session.display_title)}</span><span class="picker-date">${formatDate(session.started_at)}</span>`;
        item.addEventListener("click", () => { this.createSessionTab(session, workspacePath); picker.remove(); });
        list.appendChild(item);
      }
      refreshIcons();
    };

    renderFiltered("");
    input.addEventListener("input", () => renderFiltered(input.value));
    input.focus();

    const backdrop = document.createElement("div");
    backdrop.className = "picker-backdrop";
    backdrop.addEventListener("click", () => { picker.remove(); backdrop.remove(); });
    document.body.appendChild(backdrop);
  }

  // ─── Rendering ───

  private renderWorkspaces() {
    this.workspaceList.innerHTML = "";
    for (const ws of this.workspaces) {
      const wsDiv = document.createElement("div");
      wsDiv.className = "workspace-item";
      const isSelected = this.selectedWorkspace === ws.path;
      const isExpanded = this.expandedWorkspaces.has(ws.path);
      const wsSessions = this.sessions.get(ws.path) || [];

      const header = document.createElement("div");
      header.className = `workspace-header${isSelected ? " selected" : ""}`;

      const arrow = document.createElement("i");
      arrow.setAttribute("data-lucide", "chevron-right");
      arrow.className = `ws-arrow${isExpanded ? " expanded" : ""}`;

      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", isExpanded ? "folder-open" : "folder");

      const name = document.createElement("span");
      name.className = "ws-name";
      name.textContent = ws.name;

      const actions = document.createElement("span");
      actions.className = "ws-actions";
      const removeBtn = document.createElement("button");
      removeBtn.className = "ws-remove-btn";
      removeBtn.innerHTML = '<i data-lucide="x"></i>';
      removeBtn.title = "Remove workspace";
      removeBtn.addEventListener("click", (e) => { e.stopPropagation(); this.removeWorkspace(ws.path); });
      actions.appendChild(removeBtn);

      header.appendChild(arrow);
      header.appendChild(icon);
      header.appendChild(name);
      header.appendChild(actions);

      header.addEventListener("click", () => {
        if (isExpanded && isSelected) {
          this.expandedWorkspaces.delete(ws.path);
        } else {
          this.selectWorkspace(ws.path);
        }
        this.renderWorkspaces();
      });
      wsDiv.appendChild(header);

      if (isExpanded && wsSessions.length > 0) {
        const sessionList = document.createElement("div");
        sessionList.className = "workspace-sessions show";
        for (const session of wsSessions) {
          const isActive = this.activeSessionIds.has(session.id);
          const item = document.createElement("div");
          item.className = `session-item${isActive ? " active" : ""}`;
          item.innerHTML = `
            <i data-lucide="${isActive ? "circle-dot" : "circle"}" class="session-icon"></i>
            <span class="session-title" title="${escapeHtml(session.display_title)}">${escapeHtml(session.display_title)}</span>
            <span class="session-date">${formatDate(session.started_at)}</span>`;
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            this.createSessionTab(session, ws.path);
            this.renderWorkspaces();
          });
          sessionList.appendChild(item);
        }
        wsDiv.appendChild(sessionList);
      }
      this.workspaceList.appendChild(wsDiv);
    }
    refreshIcons();
  }

  private renderTabs() {
    this.tabList.innerHTML = "";
    for (const tab of this.tabs.values()) {
      const tabEl = document.createElement("div");
      tabEl.className = `tab-item${tab.id === this.activeTabId ? " active" : ""}`;
      tabEl.innerHTML = `
        <i data-lucide="circle" class="tab-dot-icon"></i>
        <span class="tab-title">${escapeHtml(tab.title)}</span>
        <span class="tab-close" title="Close"><i data-lucide="x"></i></span>`;
      tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => { e.stopPropagation(); this.closeTab(tab.id); });
      tabEl.addEventListener("click", () => this.activateTab(tab.id));
      this.tabList.appendChild(tabEl);
    }
    refreshIcons();
  }

  private renderFileTree(files: FileEntry[], indent = 0) {
    if (indent === 0) {
      console.log("[Shelf] renderFileTree root, files:", files.length, "expandedDirs:", [...this.expandedDirs]);
      this.fileTree.innerHTML = "";
    }

    if (files.length === 0 && indent === 0) {
      this.fileTree.innerHTML = '<div class="tree-empty">Empty directory</div>';
      return;
    }

    for (const file of files) {
      const item = document.createElement("div");
      item.className = "file-item";
      item.style.paddingLeft = `${12 + indent * 16}px`;

      if (file.is_dir) {
        const isExpanded = this.expandedDirs.has(file.path);
        const hasChildren = file.children.length > 0;
        console.log(`[Shelf] render dir: ${file.name} expanded=${isExpanded} children=${hasChildren} (${file.children.length})`);

        if (hasChildren) {
          item.innerHTML = `<i data-lucide="chevron-right" class="tree-arrow${isExpanded ? " expanded" : ""}"></i>`;
        } else {
          item.innerHTML = `<span class="tree-arrow-spacer"></span>`;
        }
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", isExpanded ? "folder-open" : "folder");
        icon.className = "tree-icon";
        item.appendChild(icon);
      } else {
        item.innerHTML = `<span class="tree-arrow-spacer"></span>`;
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", "file");
        icon.className = "tree-icon";
        item.appendChild(icon);
      }

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = file.name;

      // Make items draggable to terminal
      item.draggable = true;
      item.addEventListener("dragstart", (e: DragEvent) => {
        e.dataTransfer?.setData("text/plain", file.path);
        e.dataTransfer!.effectAllowed = "copy";
      });
      item.appendChild(name);

      if (file.is_dir && file.children.length > 0) {
        item.style.cursor = "pointer";
        item.addEventListener("click", () => {
          console.log(`[Shelf] clicked dir: ${file.path}, currently expanded: ${this.expandedDirs.has(file.path)}`);
          if (this.expandedDirs.has(file.path)) {
            this.expandedDirs.delete(file.path);
          } else {
            this.expandedDirs.add(file.path);
          }
          this.renderFileTree(this.lastFileTree, 0);
        });
      }

      this.fileTree.appendChild(item);

      if (file.is_dir && this.expandedDirs.has(file.path)) {
        this.renderFileTree(file.children, indent + 1);
      }
    }

    if (indent === 0) refreshIcons();
  }
}

// ─── Helpers ───

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch { return ""; }
}

// Bootstrap
const app = new App();
app.init();
