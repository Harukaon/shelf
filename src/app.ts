import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { tauriInvoke, refreshIcons, escapeHtml, formatDate } from "./helpers";
import { Session, FileEntry, TabInfo } from "./types";
import { TabManager } from "./modules/tabs";
import { WorkspaceManager } from "./modules/workspace";
import { createTerminalTab, writeToPty } from "./modules/terminal";
import { renderFileTree, clearFileCache } from "./modules/files";
import { setupDragDrop, setupPanelResize } from "./modules/dragdrop";
import { t, setLang, getLang } from "./i18n";
import { showTerminalMenu } from "./modules/pickers";

const START_TAB_ID = "__start__";
const SESSION_PAGE_SIZE = 6;

class App {
  tabs!: TabManager;
  ws!: WorkspaceManager;
  activeSessionIds = new Set<string>();
  focusedSessionId: string | null = null;
  shellSetting = "zsh";
  expandedDirs = new Set<string>();
  loadedDirs = new Set<string>();
  selectedWorkspace: string | null = null;

  tabList!: HTMLElement;
  tabAddBtn!: HTMLElement;
  settingsBtn!: HTMLElement;
  workspaceList!: HTMLElement;
  addWorkspaceBtn!: HTMLElement;
  refreshBtn!: HTMLElement;
  fileTreeEl!: HTMLElement;
  terminalContainer!: HTMLElement;

  async init() {
    this.tabList = document.getElementById("tab-list")!;
    this.tabAddBtn = document.getElementById("tab-add-btn")!;
    this.settingsBtn = document.getElementById("settings-btn")!;
    this.workspaceList = document.getElementById("workspace-list")!;
    this.addWorkspaceBtn = document.getElementById("add-workspace-btn")!;
    this.refreshBtn = document.getElementById("refresh-sessions-btn")!;
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
    this.settingsBtn.addEventListener("click", () => this._showSettings());
    this.refreshBtn.addEventListener("click", () => this._refreshAllSessions());
    this.addWorkspaceBtn.addEventListener("click", () => this.ws.promptAdd());

    setupDragDrop(
      this.terminalContainer,
      this.workspaceList,
      (path) => this._onTerminalDrop(path),
      (path) => this.ws.add(path),
    );

    setupPanelResize(
      document.getElementById("resize-handle-left")!,
      document.getElementById("resize-handle-right")!,
      document.getElementById("app")!,
    );

    window.addEventListener("resize", () => {
      this.tabs.tabsMap.forEach(t => {
        if (t.fitAddon) try { t.fitAddon.fit(); } catch (_) {}
      });
    });

    await this._loadSettings();
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
        <h2>${t("home.title")}</h2>
        <p>${t("home.subtitle")}</p>
        <div class="start-page-hints">
          <div><kbd>+ Add Workspace</kbd> ${t("home.hint1")}</div>
          <div>${t("home.hint2")}</div>
          <div>Press <kbd>+</kbd> ${t("home.hint3")}</div>
        </div>
        <div class="start-page-warning">${t("home.warning")}</div>
      </div>`;
    this.terminalContainer.appendChild(container);

    const tab: TabInfo = {
      id: START_TAB_ID, title: t("tab.home"), closable: false,
      terminal: null as unknown as Terminal,
      fitAddon: null as unknown as FitAddon,
      containerEl: container,
    };
    this.tabs.tabsMap.set(START_TAB_ID, tab);
    this.tabs.setInitActiveTab(START_TAB_ID);
    this._renderTabs();
  }

  private _showStartPage() {
    this.focusedSessionId = null;
    this.tabs.switchToStartPage(START_TAB_ID);
    this.selectedWorkspace = null;
    this.ws.selectedWorkspace = null;
    this.fileTreeEl.innerHTML = `<div class="tree-empty">${t("session.empty")}</div>`;
  }

  private async _loadSettings() {
    try {
      const s = await tauriInvoke<any>("get_settings");
      if (s?.shell) this.shellSetting = s.shell;
      if (s?.language) { setLang(s.language); }
    } catch (_) { /* use default */ }
  }

  private _showSettings() {
    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.innerHTML = `
      <div class="settings-title">${t("settings.title")}</div>
      <div class="settings-row"><label>${t("settings.shell")}</label><select id="settings-shell"></select></div>
      <div class="settings-row"><label>${t("settings.language")}</label>
        <select id="settings-lang">
          <option value="en">English</option>
          <option value="zh">中文</option>
        </select>
      </div>
      <div class="settings-actions">
        <button id="settings-save">${t("settings.save")}</button>
        <button id="settings-cancel">${t("settings.cancel")}</button>
      </div>`;
    const backdrop = document.createElement("div");
    backdrop.className = "picker-backdrop";
    const close = () => { panel.remove(); backdrop.remove(); };
    backdrop.addEventListener("click", close);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    // Load available terminals from system
    tauriInvoke<any>("detect_terminals").then((data) => {
      const shellSel = panel.querySelector("#settings-shell") as HTMLSelectElement;
      shellSel.innerHTML = "";
      for (const s of data.shells || ["zsh"]) {
        const opt = document.createElement("option");
        opt.value = s; opt.textContent = s;
        if (s === this.shellSetting) opt.selected = true;
        shellSel.appendChild(opt);
      }
      const langSel = panel.querySelector("#settings-lang") as HTMLSelectElement;
      langSel.value = getLang();
    }).catch(() => {});

    panel.querySelector("#settings-save")!.addEventListener("click", async () => {
      this.shellSetting = (panel.querySelector("#settings-shell") as HTMLSelectElement).value;
      const newLang = (panel.querySelector("#settings-lang") as HTMLSelectElement).value;
      setLang(newLang);
      try { await tauriInvoke("save_settings", { shell: this.shellSetting, language: newLang }); } catch (_) {}
      close();
      this._renderWorkspaces();
      this._renderTabs();
      this._createStartTab();
    });
    panel.querySelector("#settings-cancel")!.addEventListener("click", close);
  }

  private _onTabAdd() {
    showTerminalMenu(this.tabAddBtn, (cwd) => this._createBlankTab(cwd), this.selectedWorkspace);
  }

  private _newClaudeSession(wsPath: string) {
    const tabId = crypto.randomUUID();
    const tab = createTerminalTab(tabId, t("tab.claude_new"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd: wsPath, workspacePath: wsPath, shell: this.shellSetting },
    );
    this.tabs.addTab(tab);
    setTimeout(() => writeToPty(tab, `claude\n`), 600);
  }

  private async _refreshAllSessions() {
    this.refreshBtn.classList.add("spinning");
    try {
      for (const ws of this.ws.workspaces) {
        await this.ws.scanSessions(ws.path);
      }
    } finally {
      this.refreshBtn.classList.remove("spinning");
      this._renderWorkspaces();
    }
  }

  private _createBlankTab(cwd?: string) {
    const tabId = crypto.randomUUID();
    let wsPath: string | undefined;
    if (cwd) wsPath = this.ws.workspaces.find(w => cwd === w.path || cwd.startsWith(w.path + "/"))?.path;
    const tab = createTerminalTab(tabId, t("tab.terminal"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd, workspacePath: wsPath, shell: this.shellSetting },
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
      { sessionId: session.id, cwd, workspacePath: wsPath, shell: this.shellSetting },
    );
    this.tabs.addTab(tab);
    setTimeout(() => writeToPty(tab, `claude --resume ${session.id}\n`), 600);
    this.activeSessionIds.add(session.id);
    this.focusedSessionId = session.id;
  }

  private _writePty(tabId: string, data: string) {
    const tab = this.tabs.tabsMap.get(tabId);
    if (tab) writeToPty(tab, data);
  }

  private _onActivateTab(tab: TabInfo) {
    this.focusedSessionId = tab.sessionId || null;
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
      this.loadedDirs.clear();
      clearFileCache();
      await renderFileTree(this.fileTreeEl, files, this.expandedDirs, this.loadedDirs);
    } catch (e) {
      console.error("List files:", e);
      this.fileTreeEl.innerHTML = `<div class="tree-empty">${t("file.failed")}</div>`;
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
        <span class="ws-actions">
          <button class="ws-new-btn" title="${t("workspace.new")}">+</button>
          <button class="ws-remove-btn" title="${t("workspace.remove")}"><i data-lucide="trash-2"></i></button>
        </span>`;
      header.querySelector(".ws-new-btn")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this._newClaudeSession(ws.path);
      });
      const removeBtn = header.querySelector(".ws-remove-btn") as HTMLButtonElement;
      let deletePending = false;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (deletePending) {
          // Close all tabs belonging to this workspace
          const toClose: string[] = [];
          for (const [, tab] of this.tabs.tabsMap) {
            if (tab.workspacePath === ws.path && tab.closable) toClose.push(tab.id);
          }
          for (const id of toClose) {
            if (this.tabs.tabsMap.get(id)?.sessionId) {
              this.activeSessionIds.delete(this.tabs.tabsMap.get(id)!.sessionId!);
              this.focusedSessionId = null;
            }
            this.tabs.closeTab(id);
          }
          this.ws.remove(ws.path); this._showStartPage();
        } else {
          deletePending = true;
          removeBtn.style.color = "var(--red)";
          removeBtn.style.opacity = "1";
          removeBtn.innerHTML = '<i data-lucide="x"></i>';
          refreshIcons();
          setTimeout(() => {
            deletePending = false;
            removeBtn.style.opacity = "0.5";
            removeBtn.innerHTML = '<i data-lucide="trash-2"></i>';
            refreshIcons();
          }, 3000);
        }
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
          const isFocused = this.focusedSessionId === session.id;
          const item = document.createElement("div");
          item.className = `session-item${isActive ? " active" : ""}${isFocused ? " focused" : ""}`;
          const iconName = isFocused ? "disc" : "circle";
          item.innerHTML = `
            <i data-lucide="${iconName}" class="session-icon"></i>
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
      const isTabActive = tab.id === this.tabs.activeId;
      tabEl.className = `tab-item${isTabActive ? " active" : ""}`;
      const closeHtml = tab.closable ? '<span class="tab-close" title="Close"><i data-lucide="x"></i></span>' : "";
      tabEl.innerHTML = `
        <i data-lucide="${isTabActive ? "disc" : "circle"}" class="tab-dot-icon"></i>
        <span class="tab-title">${escapeHtml(tab.title)}</span>
        ${closeHtml}`;
      if (tab.closable) {
        tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tab.sessionId) {
            this.activeSessionIds.delete(tab.sessionId);
            if (this.focusedSessionId === tab.sessionId) this.focusedSessionId = null;
          }
          this.tabs.closeTab(tab.id, () => this._showStartPage());
        });
      }
      tabEl.addEventListener("click", () => this.tabs.activateTab(tab.id));
      this.tabList.appendChild(tabEl);
    }
    refreshIcons();
  }
}

new App().init();
