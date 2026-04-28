import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "tauri-pty";
import { open } from "@tauri-apps/plugin-dialog";
import { createIcons, Folder, FolderOpen, File, ChevronRight, Plus, X, Circle, CircleDot, MessageSquare, Search } from "lucide";
import "@xterm/xterm/css/xterm.css";

const ICONS = { Folder, FolderOpen, File, ChevronRight, Plus, X, Circle, CircleDot, MessageSquare, Search };
const SESSION_PAGE_SIZE = 6;
const START_TAB_ID = "__start__";

function refreshIcons() {
  createIcons({ icons: ICONS, attrs: { stroke: "currentColor", width: "14", height: "14", "stroke-width": "1.5" } });
}

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> } };
  }
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return Promise.reject(new Error("Tauri not available"));
  return tauri.core.invoke<T>(cmd, args);
}

interface WorkspaceItem { name: string; path: string; session_count: number; }
interface Session { id: string; cwd: string; display_title: string; custom_title: string | null; ai_title: string | null; first_prompt: string | null; message_count: number; started_at: string; version: string; }
interface FileEntry { name: string; path: string; is_dir: boolean; children: FileEntry[]; }
interface TabInfo { id: string; sessionId?: string; workspacePath?: string; title: string; closable: boolean; terminal: Terminal; fitAddon: FitAddon; pty?: IPty; containerEl: HTMLDivElement; }

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
  private sessionPages = new Map<string, number>();

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
    this.createStartTab();
    await this.loadWorkspaces();
  }

  // ─── Start Page Tab ───

  private createStartTab() {
    const container = document.createElement("div");
    container.className = "terminal-wrapper start-page";
    container.dataset.tabId = START_TAB_ID;
    container.style.cssText = "width:100%;height:100%;display:block;";
    container.innerHTML = `
      <div class="start-page-content">
        <div class="start-page-icon">🖥</div>
        <h2>Shelf</h2>
        <p>Select a workspace folder and click a session to start.</p>
        <div class="start-page-hints">
          <div><kbd>+ Add Workspace</kbd> to add a project folder</div>
          <div>Click a session to open it in a terminal tab</div>
          <div>Press <kbd>+</kbd> in tab bar for a blank terminal</div>
        </div>
      </div>`;
    this.terminalContainer.appendChild(container);

    const tab: TabInfo = {
      id: START_TAB_ID, title: "Home", closable: false,
      terminal: null as unknown as Terminal,
      fitAddon: null as unknown as FitAddon,
      containerEl: container,
    };
    this.tabs.set(START_TAB_ID, tab);
    this.activeTabId = START_TAB_ID;
    this.renderTabs();
  }

  private showStartPage() {
    // Hide all terminal wrappers
    this.tabs.forEach(t => { t.containerEl.style.display = "none"; });
    const start = this.tabs.get(START_TAB_ID);
    if (start) { start.containerEl.style.display = "block"; }
    this.activeTabId = START_TAB_ID;
    this.selectedWorkspace = null;
    this.fileTree.innerHTML = '<div class="tree-empty">Select a workspace</div>';
    this.renderTabs();
    this.renderWorkspaces();
  }

  // ─── Event Listeners ───

  private setupEventListeners() {
    this.tabAddBtn.addEventListener("click", () => this.onTabAddClick());
    this.addWorkspaceBtn.addEventListener("click", () => this.promptAddWorkspace());
    window.addEventListener("resize", () => {
      this.tabs.forEach(tab => { if (tab.fitAddon) try { tab.fitAddon.fit(); } catch (_) {} });
    });
  }

  private setupDragDrop() {
    let dragPath: string | null = null;
    let dragOverlay: HTMLElement | null = null;

    document.addEventListener("mousedown", (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const fileItem = target.closest(".file-item") as HTMLElement | null;
      if (!fileItem) return;
      const path = fileItem.dataset.path;
      if (!path) return;
      if (e.button !== 0) return;
      e.preventDefault();
      dragPath = path;
      document.body.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e: MouseEvent) => {
      if (!dragPath) return;
      if (!dragOverlay) {
        dragOverlay = document.createElement("div");
        dragOverlay.className = "drag-floating-label";
        dragOverlay.textContent = "\u{1F4C4} " + (dragPath.split("/").pop() || dragPath);
        document.body.appendChild(dragOverlay);
      }
      dragOverlay.style.left = `${e.clientX + 14}px`;
      dragOverlay.style.top = `${e.clientY + 14}px`;

      const elUnder = document.elementFromPoint(e.clientX, e.clientY);
      const inTerm = elUnder && (
        this.terminalContainer.contains(elUnder) ||
        !!elUnder.closest(".terminal-wrapper") ||
        !!elUnder.closest(".xterm") ||
        !!elUnder.closest(".xterm-screen")
      );
      if (inTerm) this.terminalContainer.classList.add("drag-target");
      else this.terminalContainer.classList.remove("drag-target");
    });

    document.addEventListener("mouseup", (e: MouseEvent) => {
      const path = dragPath;
      dragPath = null;
      this.terminalContainer.classList.remove("drag-target");
      document.body.style.cursor = "";
      if (dragOverlay) { dragOverlay.remove(); dragOverlay = null; }
      if (!path) return;

      const elUnder = document.elementFromPoint(e.clientX, e.clientY);
      const inTerm = elUnder && (
        this.terminalContainer.contains(elUnder) ||
        !!elUnder.closest(".terminal-wrapper") ||
        !!elUnder.closest(".xterm") ||
        !!elUnder.closest(".xterm-screen")
      );
      if (inTerm && this.activeTabId && this.activeTabId !== START_TAB_ID) {
        const tab = this.tabs.get(this.activeTabId);
        if (tab?.pty) tab.pty.write(`"${path}" `);
      }
    });

    // Workspace: Finder drop
    this.workspaceList.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      this.workspaceList.classList.add("drag-over");
    });
    this.workspaceList.addEventListener("dragleave", () => this.workspaceList.classList.remove("drag-over"));
    this.workspaceList.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      this.workspaceList.classList.remove("drag-over");
      const files = e.dataTransfer?.files;
      if (files?.[0]) {
        const file = files[0] as unknown as { path?: string };
        if (file?.path) this.addWorkspace(file.path);
      }
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
    } catch (e) { console.error("Add workspace:", e); }
  }

  private async removeWorkspace(path: string) {
    try {
      await tauriInvoke("remove_workspace", { path });
      this.workspaces = this.workspaces.filter(w => w.path !== path);
      this.sessions.delete(path);
      this.expandedWorkspaces.delete(path);
      this.sessionPages.delete(path);
      if (this.selectedWorkspace === path) this.showStartPage();
      this.renderWorkspaces();
    } catch (e) { console.error("Remove workspace:", e); }
  }

  private async selectWorkspace(path: string) {
    this.selectedWorkspace = path;
    this.expandedWorkspaces.add(path);
    if (!this.sessions.has(path)) await this.scanSessions(path);
    await this.loadFileTree(path);
    // Switch to start page when just browsing workspaces (not opening a session)
    if (this.activeTabId !== START_TAB_ID) {
      const activeTab = this.tabs.get(this.activeTabId!);
      // Only stay on session tab if it belongs to this workspace
      if (activeTab?.workspacePath !== path) {
        this.showStartPage();
        this.selectedWorkspace = path; // restore after showStartPage resets it
      }
    }
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
      this.expandedDirs.clear();
      this.lastFileTree = files;
      this.renderFileTree(files);
    } catch (e) {
      console.error("List files:", e);
      this.fileTree.innerHTML = '<div class="tree-empty">Failed to load files</div>';
    }
  }

  // ─── Tab Management ───

  private createBlankTab(cwd?: string): string {
    const tabId = crypto.randomUUID();
    const w = cwd ? this.workspaces.find(w => w.path === cwd || cwd.startsWith(w.path)) : undefined;
    const tab = this.createTerminalTab(tabId, "Terminal", undefined, cwd, w?.path);
    this.tabs.set(tabId, tab);
    this.activateTab(tabId);
    return tabId;
  }

  private createSessionTab(session: Session, workspacePath: string): string {
    for (const [id, tab] of this.tabs) {
      if (tab.sessionId === session.id) { this.activateTab(id); return id; }
    }
    const tabId = crypto.randomUUID();
    const cwd = session.cwd || workspacePath;
    const tab = this.createTerminalTab(tabId, session.display_title, session.id, cwd, workspacePath);
    this.tabs.set(tabId, tab);
    this.activateTab(tabId);
    setTimeout(() => this.writeToTab(tabId, `claude --resume ${session.id}\n`), 600);
    this.activeSessionIds.add(session.id);
    return tabId;
  }

  private getShell(): string {
    const plat = navigator.platform?.toLowerCase() || "";
    return plat.includes("win") ? "powershell.exe" : "zsh";
  }

  private createTerminalTab(tabId: string, title: string, sessionId?: string, cwd?: string, workspacePath?: string): TabInfo {
    const terminal = new Terminal({
      cursorBlink: true, fontSize: 13,
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
      pty.onData((data: Uint8Array) => terminal.write(data));
      terminal.onData((data: string) => this.writeToPty(tabId, data));
      pty.onExit(() => terminal.write("\r\n[Process exited]\r\n"));
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

    terminal.onResize(({ cols, rows }) => {
      const t = this.tabs.get(tabId);
      if (t?.pty) try { t.pty.resize(cols, rows); } catch (_) {}
    });

    return { id: tabId, sessionId, workspacePath, title, closable: true, terminal, fitAddon, pty, containerEl: wrapper };
  }

  private writeToPty(tabId: string, data: string) {
    const tab = this.tabs.get(tabId);
    if (tab?.pty) try { tab.pty.write(data); } catch (_) {}
  }

  private writeToTab(tabId: string, data: string) {
    const tab = this.tabs.get(tabId);
    if (tab?.pty) try { tab.pty.write(data); } catch (_) {}
  }

  private activateTab(tabId: string) {
    if (this.activeTabId === tabId) return;
    this.tabs.forEach(t => { t.containerEl.style.display = "none"; });
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.containerEl.style.display = "block";
      if (tab.fitAddon) { try { tab.fitAddon.fit(); tab.terminal.focus(); } catch (_) {} }
      // Sync workspace: if tab belongs to a workspace, select it
      if (tab.workspacePath) {
        this.selectedWorkspace = tab.workspacePath;
        this.expandedWorkspaces.add(tab.workspacePath);
        if (this.lastFileTree.length === 0 || this.selectedWorkspace !== tab.workspacePath) {
          this.loadFileTree(tab.workspacePath);
        }
      }
    }
    this.activeTabId = tabId;
    this.renderTabs();
    this.renderWorkspaces();
  }

  private closeTab(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.closable) return;
    if (tab.pty) try { tab.pty.kill(); } catch (_) {}
    if (tab.terminal) tab.terminal.dispose();
    tab.containerEl.remove();
    if (tab.sessionId) this.activeSessionIds.delete(tab.sessionId);
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.keys()).filter(id => id !== START_TAB_ID);
      if (remaining.length > 0) {
        this.activateTab(remaining[remaining.length - 1]);
      } else {
        this.showStartPage();
      }
    }
    this.renderTabs();
    this.renderWorkspaces();
  }

  private onTabAddClick() {
    this.showTerminalMenu();
  }

  private showTerminalMenu() {
    const menu = document.createElement("div");
    menu.className = "picker-menu";
    menu.innerHTML = `
      <div class="picker-menu-item" data-action="blank">
        <i data-lucide="plus"></i><span>New Blank Terminal</span>
      </div>
      <div class="picker-menu-item" data-action="session">
        <i data-lucide="message-square"></i><span>Open Session...</span>
      </div>`;

    const rect = this.tabAddBtn.getBoundingClientRect();
    menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;min-width:180px;z-index:1001;`;

    document.body.appendChild(menu);
    refreshIcons();

    menu.querySelector('[data-action="blank"]')!.addEventListener("click", () => {
      menu.remove(); backdrop.remove();
      this.createBlankTab(this.selectedWorkspace || undefined);
    });
    menu.querySelector('[data-action="session"]')!.addEventListener("click", () => {
      menu.remove(); backdrop.remove();
      this.showSessionPicker();
    });

    const backdrop = document.createElement("div");
    backdrop.className = "picker-backdrop";
    backdrop.addEventListener("click", () => { menu.remove(); backdrop.remove(); });
    document.body.appendChild(backdrop);
  }

  private showSessionPicker() {
    const allSessions: { session: Session; workspacePath: string }[] = [];
    for (const [wsPath, sessions] of this.sessions) {
      for (const s of sessions) allSessions.push({ session: s, workspacePath: wsPath });
    }
    if (allSessions.length === 0) { this.createBlankTab(); return; }

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
        item.addEventListener("click", () => {
          picker.remove(); backdrop.remove();
          this.createSessionTab(session, workspacePath);
        });
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
      const allSessions = this.sessions.get(ws.path) || [];
      const page = this.sessionPages.get(ws.path) || 1;
      const pageEnd = page * SESSION_PAGE_SIZE;

      const header = document.createElement("div");
      header.className = `workspace-header${isSelected ? " selected" : ""}`;
      header.innerHTML = `
        <i data-lucide="chevron-right" class="ws-arrow${isExpanded ? " expanded" : ""}"></i>
        <i data-lucide="${isExpanded ? "folder-open" : "folder"}"></i>
        <span class="ws-name">${escapeHtml(ws.name)}</span>
        <span class="ws-actions"><button class="ws-remove-btn" title="Remove workspace"><i data-lucide="x"></i></button></span>`;
      header.querySelector(".ws-remove-btn")!.addEventListener("click", (e) => { e.stopPropagation(); this.removeWorkspace(ws.path); });
      header.addEventListener("click", () => {
        if (isExpanded && isSelected) {
          this.expandedWorkspaces.delete(ws.path);
        } else {
          this.selectWorkspace(ws.path);
        }
        this.renderWorkspaces();
      });
      wsDiv.appendChild(header);

      if (isExpanded && allSessions.length > 0) {
        const sessionList = document.createElement("div");
        sessionList.className = "workspace-sessions show";
        const visible = allSessions.slice(0, pageEnd);
        for (const session of visible) {
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
        // Show "Load more" if there are more sessions
        if (pageEnd < allSessions.length) {
          const remaining = allSessions.length - pageEnd;
          const moreBtn = document.createElement("div");
          moreBtn.className = "session-load-more";
          moreBtn.textContent = `Load ${Math.min(remaining, SESSION_PAGE_SIZE)} more (${remaining} remaining)`;
          moreBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.sessionPages.set(ws.path, page + 1);
            this.renderWorkspaces();
          });
          sessionList.appendChild(moreBtn);
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
      const closeHtml = tab.closable ? `<span class="tab-close" title="Close"><i data-lucide="x"></i></span>` : "";
      tabEl.innerHTML = `
        <i data-lucide="circle" class="tab-dot-icon"></i>
        <span class="tab-title">${escapeHtml(tab.title)}</span>
        ${closeHtml}`;
      if (tab.closable) {
        tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => { e.stopPropagation(); this.closeTab(tab.id); });
      }
      tabEl.addEventListener("click", () => this.activateTab(tab.id));
      this.tabList.appendChild(tabEl);
    }
    refreshIcons();
  }

  private renderFileTree(files: FileEntry[], indent = 0) {
    if (indent === 0) { this.fileTree.innerHTML = ""; }
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
        icon.setAttribute("data-lucide", "file"); icon.className = "tree-icon";
        item.appendChild(icon);
      }

      const name = document.createElement("span");
      name.className = "tree-name"; name.textContent = file.name;
      item.dataset.path = file.path;
      item.style.cursor = "grab";
      item.appendChild(name);

      if (file.is_dir && file.children.length > 0) {
        item.style.cursor = "pointer";
        item.addEventListener("click", () => {
          if (this.expandedDirs.has(file.path)) this.expandedDirs.delete(file.path);
          else this.expandedDirs.add(file.path);
          this.renderFileTree(this.lastFileTree, 0);
        });
      }
      this.fileTree.appendChild(item);
      if (file.is_dir && this.expandedDirs.has(file.path)) this.renderFileTree(file.children, indent + 1);
    }
    if (indent === 0) refreshIcons();
  }
}

// ─── Helpers ───
function escapeHtml(str: string): string {
  const div = document.createElement("div"); div.textContent = str; return div.innerHTML;
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
const app = new App();
app.init();
