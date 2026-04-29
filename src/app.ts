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
import { showContextMenu } from "./modules/context-menu";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Sortable from "sortablejs";

const START_TAB_ID = "__start__";
const SESSION_PAGE_SIZE = 6;

class App {
  tabs!: TabManager;
  ws!: WorkspaceManager;
  activeSessionIds = new Set<string>();
  focusedSessionId: string | null = null;
  shellSetting = "zsh";
  pinnedIds = new Set<string>();
  pendingNewSessions = new Set<string>();
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
    this._updateStaticTexts();
    this._createStartTab();
    await this.ws.load();
    this._setupCloseConfirm();
    // Intercept Cmd+Q (system quit shortcut)
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "q") {
        e.preventDefault();
        e.stopPropagation();
        this._showQuitDialog();
      }
    });
    for (const ws of this.ws.workspaces) { await this.ws.scanSessions(ws.path); }
    this._renderWorkspaces();
    this._startPassivePolling();
  }

  private _createStartTab() {
    const old = this.tabs.tabsMap.get(START_TAB_ID);
    if (old) { old.containerEl.remove(); }
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
      if (s?.pinned) { this.pinnedIds = new Set(s.pinned); }
    } catch (_) { /* use default */ }
  }

  private _updateStaticTexts() {
    this.addWorkspaceBtn.textContent = t("workspace.add");
  }

  private _setupCloseConfirm() {
    const appWindow = getCurrentWebviewWindow();
    appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      this._showQuitDialog();
    });
  }

  private _showQuitDialog() {
    // Prevent stacking dialogs
    if (document.querySelector("#confirm-close")) return;

    const appWindow = getCurrentWebviewWindow();
    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.innerHTML = `
      <div class="settings-title">Quit Shelf?</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">Running terminals will be closed.</p>
      <div class="settings-actions">
        <button id="confirm-close" style="background:var(--red);color:var(--bg-primary);border:none;">Quit</button>
        <button id="cancel-close">Cancel</button>
      </div>`;
    const backdrop = document.createElement("div");
    backdrop.className = "picker-backdrop";
    const close = () => { panel.remove(); backdrop.remove(); };
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    panel.querySelector("#cancel-close")!.addEventListener("click", close);
    panel.querySelector("#confirm-close")!.addEventListener("click", () => {
      close();
      for (const [, tab] of this.tabs.tabsMap) {
        if (tab.pty) try { tab.pty.kill(); } catch (_) {}
      }
      tauriInvoke("exit_app");
    });
  }

  private _passiveTimer: ReturnType<typeof setInterval> | null = null;

  private _startPassivePolling() {
    if (this._passiveTimer) clearInterval(this._passiveTimer);
    this._passiveTimer = setInterval(() => {
      for (const ws of this.ws.workspaces) {
        tauriInvoke<Session[]>("scan_sessions", { workspacePath: ws.path }).then(sessions => {
          const old = this.ws.sessions.get(ws.path) || [];
          if (sessions.length !== old.length) {
            this.ws.sessions.set(ws.path, sessions);
            this._renderWorkspaces();
          }
        }).catch(() => {});
      }
    }, 60_000);
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
      try { await tauriInvoke("save_settings", { settings: { shell: this.shellSetting, language: newLang } }); } catch (e) { console.error("save_settings failed:", e); }
      close();
      this._updateStaticTexts();
      this._createStartTab();
      this._renderWorkspaces();
    });
    panel.querySelector("#settings-cancel")!.addEventListener("click", close);
  }

  private _onTabAdd() {
    showTerminalMenu(this.tabAddBtn, (cwd) => this._createBlankTab(cwd), this.selectedWorkspace);
  }

  private async _renameSessionPrompt(session: Session) {
    console.log("[Shelf] rename prompt for:", session.display_title, session.id);
    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.innerHTML = `
      <div class="settings-title">${t("context.rename")}</div>
      <div class="settings-row">
        <input id="rename-input" value="${escapeHtml(session.display_title)}" style="flex:1;padding:6px 10px;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:13px;outline:none;" autofocus>
      </div>
      <div class="settings-actions">
        <button id="rename-save">${t("settings.save")}</button>
        <button id="rename-cancel">${t("settings.cancel")}</button>
      </div>`;
    const backdrop = document.createElement("div");
    backdrop.className = "picker-backdrop";
    const close = () => { panel.remove(); backdrop.remove(); };
    backdrop.addEventListener("click", close);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    const input = panel.querySelector("#rename-input") as HTMLInputElement;
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
    const doSave = async () => {
      const newName = input.value.trim();
      console.log("[Shelf] rename new name:", newName);
      if (!newName) return;
      try {
        console.log("[Shelf] calling rename_session command...");
        await tauriInvoke("rename_session", { sessionId: session.id, newTitle: newName });
        console.log("[Shelf] rename_session OK, refreshing...");
        for (const ws of this.ws.workspaces) await this.ws.scanSessions(ws.path);
        this._renderWorkspaces();
      } catch (e) { console.error("Rename failed:", e); }
      close();
    };
    panel.querySelector("#rename-save")!.addEventListener("click", doSave);
    panel.querySelector("#rename-cancel")!.addEventListener("click", close);
  }

  private async _deleteSession(session: Session, wsPath: string) {
    try {
      await tauriInvoke("delete_session", { sessionId: session.id });
      this.activeSessionIds.delete(session.id);
      if (this.focusedSessionId === session.id) this.focusedSessionId = null;
      for (const [id, tab] of this.tabs.tabsMap) {
        if (tab.sessionId === session.id) this.tabs.closeTab(id);
      }
      await this.ws.scanSessions(wsPath);
      this._renderWorkspaces();
      this._showToast(t("toast.deleted"));
    } catch (e) { console.error("Delete failed:", e); }
  }

  private _showToast(msg: string) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2500);
  }

  private async _togglePin(session: Session) {
    try {
      if (this.pinnedIds.has(session.id)) {
        await tauriInvoke("unpin_session", { sessionId: session.id });
        this.pinnedIds.delete(session.id);
      } else {
        await tauriInvoke("pin_session", { sessionId: session.id });
        this.pinnedIds.add(session.id);
      }
      this._renderWorkspaces();
    } catch (e) { console.error("Pin toggle failed:", e); }
  }

  private async _newClaudeSession(wsPath: string) {
    const tabId = crypto.randomUUID();
    const tab = createTerminalTab(tabId, t("tab.claude_new"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd: wsPath, workspacePath: wsPath, command: { bin: "zsh", args: ["-l", "-c", "claude"] } },
    );
    this.tabs.addTab(tab);
    this.pendingNewSessions.add(wsPath);
    this._startPollingNewSessions(wsPath);
  }

  private _startPollingNewSessions(wsPath: string, attempt = 0) {
    if (!this.pendingNewSessions.has(wsPath)) return;
    if (attempt > 24) { this.pendingNewSessions.delete(wsPath); return; } // 2 min timeout
    setTimeout(async () => {
      if (!this.pendingNewSessions.has(wsPath)) return;
      try {
        const sessions = await tauriInvoke<Session[]>("scan_sessions", { workspacePath: wsPath });
        const old = this.ws.sessions.get(wsPath) || [];
        if (sessions.length > old.length) {
          this.ws.sessions.set(wsPath, sessions);
          this.pendingNewSessions.delete(wsPath);
          this._renderWorkspaces();
          return;
        }
      } catch (_) {}
      this._startPollingNewSessions(wsPath, attempt + 1);
    }, 5000);
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
      { sessionId: session.id, cwd, workspacePath: wsPath, command: { bin: "zsh", args: ["-l", "-c", `claude --resume ${session.id}`] } },
    );
    this.tabs.addTab(tab);
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
      await renderFileTree(this.fileTreeEl, files, this.expandedDirs, this.loadedDirs, this.selectedWorkspace || "", () => this._loadFileTree(this.selectedWorkspace!));
    } catch (e) {
      console.error("List files:", e);
      this.fileTreeEl.innerHTML = `<div class="tree-empty">${t("file.failed")}</div>`;
    }
  }

  private _renderWorkspaces() {
    this.workspaceList.innerHTML = "";

    // Pinned section
    if (this.pinnedIds.size > 0) {
      const pinnedDiv = document.createElement("div");
      pinnedDiv.className = "pinned-section";
      pinnedDiv.innerHTML = `<div class="pinned-label"><i data-lucide="pin"></i> Pinned</div>`;
      for (const ws of this.ws.workspaces) {
        const sessions = this.ws.sessions.get(ws.path) || [];
        for (const session of sessions) {
          if (!this.pinnedIds.has(session.id)) continue;
          const isActive = this.activeSessionIds.has(session.id);
          const isFocused = this.focusedSessionId === session.id;
          const item = document.createElement("div");
          item.className = `session-item pinned-item${isActive ? " active" : ""}${isFocused ? " focused" : ""}`;
          item.innerHTML = `
            <span class="dot-icon${isFocused ? " focused" : ""}"></span>
            <div class="pinned-info">
              <span class="session-title">${escapeHtml(session.display_title)}</span>
              <span class="pinned-path">${escapeHtml(ws.name)}</span>
            </div>
            <span class="session-date">${formatDate(session.started_at)}</span>`;
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            this._openSessionTab(session, ws.path);
            this._renderWorkspaces();
          });
          item.addEventListener("contextmenu", (e) => {
            e.preventDefault(); e.stopPropagation();
            showContextMenu([
              { label: t("context.unpin"), action: () => this._togglePin(session) },
              { label: t("context.rename"), action: () => this._renameSessionPrompt(session) },
              { label: t("context.delete"), action: () => this._deleteSession(session, ws.path) },
            ], e.clientX, e.clientY);
          });
          pinnedDiv.appendChild(item);
        }
      }
      this.workspaceList.appendChild(pinnedDiv);
    }

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
            <span class="dot-icon${isFocused ? " focused" : ""}"></span>
            <span class="session-title" title="${escapeHtml(session.display_title)}">${escapeHtml(session.display_title)}</span>
            <span class="session-date">${formatDate(session.started_at)}</span>`;
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            this._openSessionTab(session, ws.path);
            this._renderWorkspaces();
          });
          item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log("[Shelf] session contextmenu:", session.display_title);
            const isPinned = this.pinnedIds.has(session.id);
            showContextMenu(
              [{ label: t("context.rename"), action: () => this._renameSessionPrompt(session) },
               { label: isPinned ? t("context.unpin") : t("context.pin"), action: () => this._togglePin(session) },
               { label: t("context.delete"), action: () => this._deleteSession(session, ws.path) }],
              e.clientX, e.clientY,
            );
          });
          sessionList.appendChild(item);
        }
        if (pageEnd < allSessions.length) {
          const remaining = allSessions.length - pageEnd;
          const moreBtn = document.createElement("div");
          moreBtn.className = "session-load-more";
          moreBtn.textContent = `${t("session.load")} ${Math.min(remaining, SESSION_PAGE_SIZE)} ${t("session.load_more")} (${remaining} ${t("session.remaining")})`;
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

  private _sortable: Sortable | null = null;

  private _renderTabs() {
    this.tabList.innerHTML = "";
    if (this._sortable) { this._sortable.destroy(); this._sortable = null; }
    const order = this.tabs.getTabOrder();

    for (const tabId of order) {
      const tab = this.tabs.tabsMap.get(tabId)!;
      const tabEl = document.createElement("div");
      const isTabActive = tab.id === this.tabs.activeId;
      tabEl.className = `tab-item${isTabActive ? " active" : ""}${tab.closable ? " closable" : ""}`;
      tabEl.dataset.tabId = tab.id;
      const closeHtml = tab.closable ? '<span class="tab-close" title="Close"><i data-lucide="x"></i></span>' : "";
      tabEl.innerHTML = `
        <span class="dot-icon${isTabActive ? " active" : ""}"></span>
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
      tabEl.addEventListener("auxclick", (e) => {
        if (e.button === 1 && tab.closable) {
          e.preventDefault();
          if (tab.sessionId) {
            this.activeSessionIds.delete(tab.sessionId);
            if (this.focusedSessionId === tab.sessionId) this.focusedSessionId = null;
          }
          this.tabs.closeTab(tab.id, () => this._showStartPage());
        }
      });
      this.tabList.appendChild(tabEl);
    }
    refreshIcons();

    // SortableJS for drag-to-reorder
    const self = this;
    this._sortable = Sortable.create(this.tabList, {
      animation: 150,
      draggable: ".tab-item.closable",
      filter: ".tab-close",
      preventOnFilter: false,
      forceFallback: true,
      onEnd(evt) {
        console.log("[Shelf] sortable onEnd tabId:", evt.item.dataset.tabId, "oldIndex:", evt.oldIndex, "newIndex:", evt.newIndex);
        const tabId = evt.item.dataset.tabId;
        if (tabId && evt.newIndex != null) {
          self.tabs.reorderSilent(tabId, evt.newIndex);
        }
      },
    });
  }
}

new App().init();
