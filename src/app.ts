import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { tauriInvoke, refreshIcons, escapeHtml, formatDate } from "./helpers";
import { Session, FileEntry, TabInfo } from "./types";
import { TabManager } from "./modules/tabs";
import { WorkspaceManager } from "./modules/workspace";
import { createTerminalTab, writeToPty } from "./modules/terminal";
import { renderFileTree } from "./modules/files";
import { setupDragDrop } from "./modules/dragdrop";
import { showTerminalMenu } from "./modules/pickers";

const START_TAB_ID = "__start__";
const SESSION_PAGE_SIZE = 6;

class App {
  tabs!: TabManager;
  ws!: WorkspaceManager;
  activeSessionIds = new Set<string>();
  expandedDirs = new Set<string>();
  lastFileTree: FileEntry[] = [];
  selectedWorkspace: string | null = null;

  tabList!: HTMLElement;
  tabAddBtn!: HTMLElement;
  workspaceList!: HTMLElement;
  addWorkspaceBtn!: HTMLElement;
  fileTreeEl!: HTMLElement;
  terminalContainer!: HTMLElement;

  async init() {
    this.tabList = document.getElementById("tab-list")!;
    this.tabAddBtn = document.getElementById("tab-add-btn")!;
    this.workspaceList = document.getElementById("workspace-list")!;
    this.addWorkspaceBtn = document.getElementById("add-workspace-btn")!;
    this.fileTreeEl = document.getElementById("file-tree")!;
    this.terminalContainer = document.getElementById("terminal-container")!;

    this.tabs = new TabManager(
      this.tabList, this.terminalContainer,
      () => this._renderTabs(), () => this._renderWorkspaces(),
      (tab) => this._onActivateTab(tab),
    );

    this.ws = new WorkspaceManager(
      () => this._renderWorkspaces(),
      (path) => { if (path) this._onWorkspaceSelected(path); },
    );

    this.tabAddBtn.addEventListener("click", () => this._onTabAdd());
    this.addWorkspaceBtn.addEventListener("click", () => this.ws.promptAdd());

    setupDragDrop(
      this.terminalContainer,
      this.workspaceList,
      (path) => this._onTerminalDrop(path),
      (path) => this.ws.add(path),
    );

    window.addEventListener("resize", () => {
      this.tabs.tabsMap.forEach(t => {
        if (t.fitAddon) try { t.fitAddon.fit(); } catch (_) {}
      });
    });

    this._createStartTab();
    await this.ws.load();
  }

  private _createStartTab() {
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
    this.tabs.tabsMap.set(START_TAB_ID, tab);
    this.tabs.setInitActiveTab(START_TAB_ID);
    this._renderTabs();
  }

  private _showStartPage() {
    this.tabs.switchToStartPage(START_TAB_ID);
    this.selectedWorkspace = null;
    this.ws.selectedWorkspace = null;
    this.fileTreeEl.innerHTML = '<div class="tree-empty">Select a workspace</div>';
  }

  private _onTabAdd() {
    showTerminalMenu(
      this.tabAddBtn,
      (cwd) => this._createBlankTab(cwd),
      (session, wsPath) => this._openSessionTab(session, wsPath),
      () => this.ws.getAllSessions(),
      this.selectedWorkspace,
    );
  }

  private _createBlankTab(cwd?: string) {
    const tabId = crypto.randomUUID();
    let wsPath: string | undefined;
    if (cwd) wsPath = this.ws.workspaces.find(w => cwd === w.path || cwd.startsWith(w.path + "/"))?.path;
    const tab = createTerminalTab(tabId, "Terminal", this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd, workspacePath: wsPath },
    );
    this.tabs.addTab(tab);
  }

  private _openSessionTab(session: Session, wsPath: string) {
    for (const [, tab] of this.tabs.tabsMap) {
      if (tab.sessionId === session.id) { this.tabs.activateTab(tab.id); return; }
    }
    const tabId = crypto.randomUUID();
    const cwd = session.cwd || wsPath;
    const tab = createTerminalTab(tabId, session.display_title, this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { sessionId: session.id, cwd, workspacePath: wsPath },
    );
    this.tabs.addTab(tab);
    setTimeout(() => writeToPty(tab, `claude --resume ${session.id}\n`), 600);
    this.activeSessionIds.add(session.id);
  }

  private _writePty(tabId: string, data: string) {
    const tab = this.tabs.tabsMap.get(tabId);
    if (tab) writeToPty(tab, data);
  }

  private _onActivateTab(tab: TabInfo) {
    if (tab.workspacePath) {
      this.selectedWorkspace = tab.workspacePath;
      this.ws.selectedWorkspace = tab.workspacePath;
      this.ws.expandedWorkspaces.add(tab.workspacePath);
      this._loadFileTree(tab.workspacePath);
    }
  }

  private _onTerminalDrop(path: string) {
    const tab = this.tabs.getActiveTab();
    if (tab && tab.id !== START_TAB_ID && tab.pty) {
      writeToPty(tab, `"${path}" `);
    }
  }

  private _onWorkspaceSelected(newPath: string) {
    this.selectedWorkspace = newPath;
    this._loadFileTree(newPath);
    const activeTab = this.tabs.getActiveTab();
    if (!activeTab || activeTab.workspacePath !== newPath) {
      this._showStartPage();
      this.selectedWorkspace = newPath;
      this.ws.selectedWorkspace = newPath;
    }
  }

  private async _loadFileTree(path: string) {
    try {
      const files = await tauriInvoke<FileEntry[]>("list_files", { path });
      this.expandedDirs.clear();
      this.lastFileTree = files;
      renderFileTree(this.fileTreeEl, files, this.expandedDirs, this.lastFileTree);
    } catch (e) {
      console.error("List files:", e);
      this.fileTreeEl.innerHTML = '<div class="tree-empty">Failed to load files</div>';
    }
  }

  private _renderWorkspaces() {
    this.workspaceList.innerHTML = "";
    for (const ws of this.ws.workspaces) {
      const wsDiv = document.createElement("div");
      wsDiv.className = "workspace-item";
      const isSelected = this.selectedWorkspace === ws.path;
      const isExpanded = this.ws.expandedWorkspaces.has(ws.path);
      const allSessions = this.ws.sessions.get(ws.path) || [];
      const page = this.ws.sessionPages.get(ws.path) || 1;
      const pageEnd = page * SESSION_PAGE_SIZE;

      const header = document.createElement("div");
      header.className = `workspace-header${isSelected ? " selected" : ""}`;
      header.innerHTML = `
        <i data-lucide="chevron-right" class="ws-arrow${isExpanded ? " expanded" : ""}"></i>
        <i data-lucide="${isExpanded ? "folder-open" : "folder"}"></i>
        <span class="ws-name">${escapeHtml(ws.name)}</span>
        <span class="ws-actions"><button class="ws-remove-btn" title="Remove workspace"><i data-lucide="x"></i></button></span>`;
      header.querySelector(".ws-remove-btn")!.addEventListener("click", (e) => {
        e.stopPropagation(); this.ws.remove(ws.path); this._showStartPage();
      });
      header.addEventListener("click", () => {
        if (isExpanded && isSelected) this.ws.expandedWorkspaces.delete(ws.path);
        else this.ws.select(ws.path);
        this._renderWorkspaces();
      });
      wsDiv.appendChild(header);

      if (isExpanded && allSessions.length > 0) {
        const sessionList = document.createElement("div");
        sessionList.className = "workspace-sessions show";
        for (const session of allSessions.slice(0, pageEnd)) {
          const isActive = this.activeSessionIds.has(session.id);
          const item = document.createElement("div");
          item.className = `session-item${isActive ? " active" : ""}`;
          item.innerHTML = `
            <i data-lucide="${isActive ? "circle-dot" : "circle"}" class="session-icon"></i>
            <span class="session-title" title="${escapeHtml(session.display_title)}">${escapeHtml(session.display_title)}</span>
            <span class="session-date">${formatDate(session.started_at)}</span>`;
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            this._openSessionTab(session, ws.path);
            this._renderWorkspaces();
          });
          sessionList.appendChild(item);
        }
        if (pageEnd < allSessions.length) {
          const remaining = allSessions.length - pageEnd;
          const moreBtn = document.createElement("div");
          moreBtn.className = "session-load-more";
          moreBtn.textContent = `Load ${Math.min(remaining, SESSION_PAGE_SIZE)} more (${remaining} remaining)`;
          moreBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.ws.sessionPages.set(ws.path, page + 1);
            this._renderWorkspaces();
          });
          sessionList.appendChild(moreBtn);
        }
        wsDiv.appendChild(sessionList);
      }
      this.workspaceList.appendChild(wsDiv);
    }
    refreshIcons();
  }

  private _renderTabs() {
    this.tabList.innerHTML = "";
    for (const tab of this.tabs.tabsMap.values()) {
      const tabEl = document.createElement("div");
      tabEl.className = `tab-item${tab.id === this.tabs.activeId ? " active" : ""}`;
      const closeHtml = tab.closable ? '<span class="tab-close" title="Close"><i data-lucide="x"></i></span>' : "";
      tabEl.innerHTML = `
        <i data-lucide="circle" class="tab-dot-icon"></i>
        <span class="tab-title">${escapeHtml(tab.title)}</span>
        ${closeHtml}`;
      if (tab.closable) {
        tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
          e.stopPropagation(); this.tabs.closeTab(tab.id, () => this._showStartPage());
        });
      }
      tabEl.addEventListener("click", () => this.tabs.activateTab(tab.id));
      this.tabList.appendChild(tabEl);
    }
    refreshIcons();
  }
}

new App().init();
