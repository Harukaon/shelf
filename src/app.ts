import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { tauriInvoke, refreshIcons, escapeHtml, formatDate } from "./helpers";
import { Session, FileEntry, TabInfo, SessionProvider, AiSettings, AiSessionMap, AiRunResponse, AiModelListResponse, AiHistoryMessage, AiGroup, ShellCommandApproval } from "./types";
import { TabManager } from "./modules/tabs";
import { WorkspaceManager } from "./modules/workspace";
import { applyTerminalTheme, createTerminalTab, repaintTerminal, scheduleTerminalRefit, setTerminalThemeMode, writeToPty, type TerminalThemeMode } from "./modules/terminal";
import { renderFileTree, clearFileCache, setupFileTreeContextMenu } from "./modules/files";
import { setupDragDrop, setupPanelResize } from "./modules/dragdrop";
import { t, setLang, getLang } from "./i18n";
import { showTerminalMenu } from "./modules/pickers";
import { showContextMenu } from "./modules/context-menu";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import Sortable from "sortablejs";

const START_TAB_ID = "__start__";
const SESSION_PAGE_SIZE = 6;
const SESSION_POLL_INTERVAL_MS = 60_000;
const PENDING_SESSION_POLL_INTERVAL_MS = 5_000;
const PENDING_SESSION_DISCOVERY_TIMEOUT_MS = 120_000;
const PENDING_SESSION_STABILIZE_MS = 45_000;
const THEME_STORAGE_KEY = "shelf.theme";

type AppTheme = "dark" | "light" | "github-light" | "solarized-light" | "dracula" | "monokai";

const APP_THEMES = new Set<AppTheme>(["dark", "light", "github-light", "solarized-light", "dracula", "monokai"]);

type PendingSessionTab = {
  workspacePath: string;
  provider: SessionProvider;
  baselineIds: Set<string>;
  startedAt: number;
  linkedSessionId?: string;
  stableUntil?: number;
  timer?: ReturnType<typeof setTimeout>;
};

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

type SavedWindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
};

type SavedTabState = {
  id: string;
  kind: "terminal" | "session" | "new-session";
  title: string;
  cwd?: string;
  workspacePath?: string;
  sessionProvider?: SessionProvider;
  sessionId?: string;
  shell?: string;
};

type SavedAppState = {
  version: 1;
  activeTabId?: string;
  selectedWorkspace?: string | null;
  selectedProvider?: SessionProvider | null;
  window?: SavedWindowState;
  tabs: SavedTabState[];
};

type AiStreamEvent = {
  kind: "text" | "tool-start" | "tool-end" | "tool-result" | "shell-approval" | "error" | "done";
  id?: string | null;
  text?: string | null;
  tool?: string | null;
};

type AiToolMessage = {
  id: string;
  tool: string;
  el: HTMLElement;
  statusEl: HTMLElement;
  codeEl: HTMLElement;
  actionsEl?: HTMLElement;
  approval?: ShellCommandApproval;
};

class App {
  tabs!: TabManager;
  ws!: WorkspaceManager;
  activeSessionIds = new Set<string>();
  focusedSessionId: string | null = null;
  shellSetting = "zsh";
  theme: AppTheme = "dark";
  claudePath = "claude";
  codexPath = "codex";
  pinnedIds = new Set<string>();
  pendingSessionTabs = new Map<string, PendingSessionTab>();
  sessionScanSeq = new Map<string, number>();
  restoredState: SavedAppState | null = null;
  restoreInProgress = false;
  appStateReady = false;
  saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  expandedDirs = new Set<string>();
  loadedDirs = new Set<string>();
  selectedWorkspace: string | null = null;
  aiSessionMap: AiSessionMap = { version: 1, groups: {}, sessions: {} };
  aiWindowEl: HTMLElement | null = null;
  aiLogEl: HTMLElement | null = null;
  aiInputEl: HTMLTextAreaElement | null = null;
  aiStreamUnlisten: UnlistenFn | null = null;
  aiStreamAssistantMsg: HTMLElement | null = null;
  aiStreamTools = new Map<string, AiToolMessage>();
  aiHistory: AiHistoryMessage[] = [];
  aiBusy = false;
  aiInputComposing = false;
  aiPendingShellApproval = false;
  aiShellAutoApprove = false;
  expandedAiOrganizer = true;
  collapsedAiCategories = new Set<string>();

  tabList!: HTMLElement;
  tabAddBtn!: HTMLElement;
  aiBtn!: HTMLElement;
  settingsBtn!: HTMLElement;
  workspaceList!: HTMLElement;
  addWorkspaceBtn!: HTMLElement;
  refreshBtn!: HTMLElement;
  fileTreeEl!: HTMLElement;
  terminalContainer!: HTMLElement;

  async init() {
    this.tabList = document.getElementById("tab-list")!;
    this.tabAddBtn = document.getElementById("tab-add-btn")!;
    this.aiBtn = document.getElementById("ai-btn")!;
    this.settingsBtn = document.getElementById("settings-btn")!;
    this.workspaceList = document.getElementById("workspace-list")!;
    this.addWorkspaceBtn = document.getElementById("add-workspace-btn")!;
    this.refreshBtn = document.getElementById("refresh-sessions-btn")!;
    this.fileTreeEl = document.getElementById("file-tree")!;
    this.terminalContainer = document.getElementById("terminal-container")!;
    this._loadTheme();
    this._applyTheme();

    this.tabs = new TabManager(
      this.tabList, this.terminalContainer,
      () => this._renderTabs(), () => this._renderWorkspaces(),
      (tab) => this._onActivateTab(tab),
      (tabId, hasUnread) => this._onUnreadChange(tabId, hasUnread),
    );

    this.ws = new WorkspaceManager(
      () => this._renderWorkspaces(),
      (path) => { if (path) this._onWorkspaceSelected(path); },
      async (path, provider) => { await this._refreshWorkspaceSessions(path, provider, "manual"); },
    );

    this.tabAddBtn.addEventListener("click", () => this._onTabAdd());
    this.aiBtn.addEventListener("click", () => this._toggleAiWindow());
    this.settingsBtn.addEventListener("click", () => this._showSettings());
    this.refreshBtn.addEventListener("click", () => this._refreshAllSessions());
    this.addWorkspaceBtn.addEventListener("click", (e) => {
      const rect = this.addWorkspaceBtn.getBoundingClientRect();
      showContextMenu([
        { label: "Claude Code", action: () => this.ws.promptAdd("claude") },
        { label: "Codex", action: () => this.ws.promptAdd("codex") },
      ], rect.left, rect.top);
      e.stopPropagation();
    });
    setupFileTreeContextMenu(this.fileTreeEl, () => this._refreshCurrentFileTree());

    this._setupPlatformWindowControls();

    setupDragDrop(
      this.terminalContainer,
      this.workspaceList,
      (path) => this._onTerminalDrop(path),
      (path) => this.ws.add(path, "claude"),
    );

    setupPanelResize(
      document.getElementById("resize-handle-left")!,
      document.getElementById("resize-handle-right")!,
      document.getElementById("app")!,
    );

    window.addEventListener("resize", () => {
      const tab = this.tabs.getActiveTab();
      if (tab) scheduleTerminalRefit(tab);
      this._scheduleSaveAppState();
    });

    await this._loadSettings();
    await this._loadAiSessionMap();
    await this._loadSavedAppState();
    await this._restoreWindowState();
    this._updateStaticTexts();
    await this._loadClaudePath();
    await this._loadCodexPath();
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        getCurrentWebviewWindow().hide();
      }
    });
    for (const ws of this.ws.workspaces) { await this._refreshWorkspaceSessions(ws.path, ws.provider, "init"); }
    await this._restoreSavedTabs();
    this._renderWorkspaces();
    this._setupWindowStateTracking();
    this.appStateReady = true;
    this._scheduleSaveAppState();
    this._startPassivePolling();
  }

  private async _loadClaudePath() {
    try {
      const path = await tauriInvoke<string>("find_claude");
      if (path) { this.claudePath = path; console.log("[Shelf] claude found at:", path); }
    } catch (_) { console.warn("[Shelf] claude not found, using default"); }
  }

  private async _loadCodexPath() {
    try {
      const path = await tauriInvoke<string>("find_codex");
      if (path) { this.codexPath = path; console.log("[Shelf] codex found at:", path); }
    } catch (_) { console.warn("[Shelf] codex not found, using default"); }
  }

  private async _loadAiSessionMap() {
    try {
      const map = await tauriInvoke<AiSessionMap>("get_ai_session_map");
      this.aiSessionMap = map || { version: 1, groups: {}, sessions: {} };
    } catch (e) {
      console.warn("[Shelf] AI session map not available:", e);
      this.aiSessionMap = { version: 1, groups: {}, sessions: {} };
    }
  }

  private async _saveAiSessionMap() {
    try {
      await tauriInvoke("save_ai_session_map", { map: this.aiSessionMap });
    } catch (e) {
      console.error("[Shelf] save AI session map failed:", e);
    }
  }

  private _displayTitleForSession(session: Session): string {
    return session.display_title;
  }

  private async _loadSavedAppState() {
    try {
      const state = await tauriInvoke<Partial<SavedAppState>>("get_app_state");
      if (state?.version === 1 && Array.isArray(state.tabs)) {
        this.restoredState = state as SavedAppState;
      }
    } catch (e) {
      console.warn("[Shelf] app state not available:", e);
    }
  }

  private async _restoreWindowState() {
    const state = this.restoredState?.window;
    if (!state) return;

    try {
      const win = getCurrentWebviewWindow();
      if (state.width > 0 && state.height > 0) {
        await win.setSize(new PhysicalSize(state.width, state.height));
      }
      await win.setPosition(new PhysicalPosition(state.x, state.y));
      if (state.maximized) await win.maximize();
    } catch (e) {
      console.warn("[Shelf] restore window state failed:", e);
    }
  }

  private _createStartTab() {
    const previousActiveId = this.tabs.activeId;
    const shouldActivateStart = !previousActiveId || previousActiveId === START_TAB_ID;
    const old = this.tabs.tabsMap.get(START_TAB_ID);
    if (old) { old.containerEl.remove(); }
    const container = document.createElement("div");
    container.className = "terminal-wrapper start-page";
    container.dataset.tabId = START_TAB_ID;
    container.style.cssText = `visibility:${shouldActivateStart ? "visible" : "hidden"};pointer-events:${shouldActivateStart ? "auto" : "none"};`;
    container.innerHTML = `
      <div class="start-page-content">
        <div class="start-page-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="48" height="48"><defs><linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#89B4FA"/><stop offset="100%" stop-color="#74C7EC"/></linearGradient></defs><rect x="16" y="16" width="480" height="480" rx="108" fill="#1E1E2E"/><text x="100" y="320" font-family="SF Mono, Menlo, monospace" font-size="260" font-weight="700" fill="url(#g1)">&gt;_</text><rect x="100" y="370" width="312" height="10" rx="5" fill="#45475A" opacity="0.6"/><rect x="140" y="400" width="232" height="10" rx="5" fill="#45475A" opacity="0.4"/><rect x="170" y="430" width="172" height="10" rx="5" fill="#45475A" opacity="0.25"/></svg></div>
        <h2>${t("home.title")}</h2>
        <p>${t("home.subtitle")}</p>
        <div class="start-page-hints">
          <div><kbd>${t("workspace.add")}</kbd> ${t("home.hint1")}</div>
          <div>${t("home.hint2")}</div>
          <div>${t("home.hint3_prefix")} <kbd>+</kbd> ${t("home.hint3")}</div>
        </div>
        <div class="start-page-warning">${t("home.warning")}</div>
      </div>`;
    this.terminalContainer.appendChild(container);

    const tab: TabInfo = {
      id: START_TAB_ID, title: t("tab.home"), closable: false,
      terminal: null as unknown as Terminal,
      fitAddon: null as unknown as FitAddon,
      containerEl: container,
      active: shouldActivateStart,
    };
    this.tabs.tabsMap.set(START_TAB_ID, tab);
    if (shouldActivateStart) this.tabs.setInitActiveTab(START_TAB_ID);
    this._renderTabs();
  }

  private _showStartPage() {
    this.focusedSessionId = null;
    this.tabs.switchToStartPage(START_TAB_ID);
    this.selectedWorkspace = null;
    this.ws.selectedWorkspace = null;
    this.ws.selectedProvider = null;
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

  private _loadTheme() {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      this.theme = APP_THEMES.has(saved as AppTheme) ? saved as AppTheme : "dark";
    } catch (_) {
      this.theme = "dark";
    }
  }

  private _setTheme(theme: AppTheme) {
    this.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (_) {
      /* localStorage may be unavailable in restricted contexts */
    }
    this._applyTheme();
  }

  private _applyTheme() {
    document.documentElement.dataset.theme = this.theme;
    setTerminalThemeMode(this.theme as TerminalThemeMode);
    if (!this.tabs) return;
    for (const tab of this.tabs.tabsMap.values()) {
      applyTerminalTheme(tab.terminal, this.theme as TerminalThemeMode);
    }
  }

  private _updateStaticTexts() {
    this.addWorkspaceBtn.textContent = t("workspace.add");
    this.tabAddBtn.setAttribute("title", t("tab.new"));
    this.aiBtn.setAttribute("title", t("ai.title"));
    this.settingsBtn.setAttribute("title", t("settings.title"));
    document.getElementById("win-minimize")?.setAttribute("title", t("window.minimize"));
    document.getElementById("win-minimize")?.setAttribute("aria-label", t("window.minimize"));
    document.getElementById("win-maximize")?.setAttribute("title", t("window.maximize"));
    document.getElementById("win-maximize")?.setAttribute("aria-label", t("window.maximize"));
    document.getElementById("win-close")?.setAttribute("title", t("tab.close"));
    document.getElementById("win-close")?.setAttribute("aria-label", t("tab.close"));
  }

  private _setupPlatformWindowControls() {
    const platform = navigator.platform.toLowerCase();
    const isMac = platform.includes("mac");
    document.body.setAttribute("data-platform", isMac ? "macos" : "windows");

    const tabBar = document.getElementById("tab-bar")!;
    const win = getCurrentWebviewWindow();
    tabBar.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0 || e.detail > 1 || !this._isWindowDragTarget(e.target)) return;
      e.preventDefault();
      win.startDragging();
    });
    tabBar.addEventListener("dblclick", (e: MouseEvent) => {
      if (!this._isWindowDragTarget(e.target)) return;
      e.preventDefault();
      win.toggleMaximize();
    });

    if (!isMac) {
      document.getElementById("win-minimize")!.addEventListener("click", () => win.minimize());
      document.getElementById("win-maximize")!.addEventListener("click", () => win.toggleMaximize());
      document.getElementById("win-close")!.addEventListener("click", () => win.close());
      document.querySelectorAll<HTMLElement>(".window-resize-zone").forEach((zone) => {
        zone.addEventListener("mousedown", (e: MouseEvent) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const direction = zone.dataset.resizeDirection as ResizeDirection | undefined;
          if (direction) win.startResizeDragging(direction);
        });
      });
    }
  }

  private _isWindowDragTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return !el.closest("button, .tab-item, .tab-close, #window-controls");
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
      <div class="settings-title">${t("settings.quit_title")}</div>
      <p class="settings-note">${t("settings.quit_note")}</p>
      <div class="settings-actions">
        <button id="confirm-close" class="danger">${t("settings.quit")}</button>
        <button id="cancel-close">${t("settings.cancel")}</button>
      </div>`;
    const backdrop = document.createElement("div");
    backdrop.className = "picker-backdrop";
    const close = () => { panel.remove(); backdrop.remove(); };
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    panel.querySelector("#cancel-close")!.addEventListener("click", close);
    panel.querySelector("#confirm-close")!.addEventListener("click", async () => {
      close();
      if (this.saveStateTimer) {
        clearTimeout(this.saveStateTimer);
        this.saveStateTimer = null;
      }
      await this._saveAppStateNow();
      await this.tabs.closeAllPtys();
      await tauriInvoke("exit_app");
    });
  }

  private _passiveTimer: ReturnType<typeof setInterval> | null = null;

  private _startPassivePolling() {
    if (this._passiveTimer) clearInterval(this._passiveTimer);
    this._passiveTimer = setInterval(() => {
      for (const ws of this.ws.workspaces) {
        this._refreshWorkspaceSessions(ws.path, ws.provider, "passive").catch(() => {});
      }
    }, SESSION_POLL_INTERVAL_MS);
  }

  private async _refreshWorkspaceSessions(
    workspacePath: string,
    provider: SessionProvider,
    reason: "init" | "passive" | "manual" | "new-session" | "rename" | "delete",
  ): Promise<{ sessions: Session[]; changed: boolean }> {
    const key = this.ws.workspaceKey(workspacePath, provider);
    const seq = (this.sessionScanSeq.get(key) || 0) + 1;
    this.sessionScanSeq.set(key, seq);
    const command = provider === "codex" ? "scan_codex_sessions" : "scan_sessions";
    const sessions = await tauriInvoke<Session[]>(command, { workspacePath }).catch((e) => {
      console.error(`Scan ${provider} sessions:`, e);
      return [];
    });
    if (this.sessionScanSeq.get(key) !== seq) {
      return { sessions: this.ws.sessions.get(key) || [], changed: false };
    }
    const changed = this._applySessionSnapshot(workspacePath, provider, sessions, reason);
    return { sessions, changed };
  }

  private _applySessionSnapshot(
    workspacePath: string,
    provider: SessionProvider,
    sessions: Session[],
    _reason: string,
  ): boolean {
    const key = this.ws.workspaceKey(workspacePath, provider);
    const hadSnapshot = this.ws.sessions.has(key);
    const oldSessions = this.ws.sessions.get(key) || [];
    const changed = !hadSnapshot || !this._sessionListsEquivalent(oldSessions, sessions);
    if (!changed) return false;

    this.ws.sessions.set(key, sessions);
    this._syncOpenTabsWithSessions(workspacePath, provider, sessions);
    this._linkPendingTabsFromSnapshot(workspacePath, provider, sessions, oldSessions);
    this._syncActiveSessionIds();
    this._syncFocusedSessionId();
    this._renderTabs();
    this._renderWorkspaces();
    return true;
  }

  private _sessionListsEquivalent(a: Session[], b: Session[]): boolean {
    if (a.length !== b.length) return false;
    const bById = new Map(b.map((session) => [session.id, session]));
    for (const oldSession of a) {
      const nextSession = bById.get(oldSession.id);
      if (!nextSession || this._sessionFingerprint(oldSession) !== this._sessionFingerprint(nextSession)) {
        return false;
      }
    }
    return true;
  }

  private _sessionFingerprint(session: Session): string {
    return [
      session.id,
      session.display_title,
      session.custom_title || "",
      session.ai_title || "",
      session.first_prompt || "",
      session.message_count,
      session.started_at,
      session.updated_at,
      session.file_path,
      session.provider,
      session.version,
    ].join("\u001f");
  }

  private _syncOpenTabsWithSessions(workspacePath: string, provider: SessionProvider, sessions: Session[]) {
    const byId = new Map(sessions.map((session) => [session.id, session]));

    for (const tab of this.tabs.tabsMap.values()) {
      if (!tab.sessionId || tab.workspacePath !== workspacePath || tab.sessionProvider !== provider) continue;
      const session = byId.get(tab.sessionId);
      if (!session) continue;
      const title = this._displayTitleForSession(session);
      if (tab.title !== title) {
        tab.title = title;
      }
    }
  }

  private _findSessionByKey(sessionKey: string): { session: Session; workspacePath: string } | null {
    const [provider, sessionId] = sessionKey.split(":", 2) as [SessionProvider | undefined, string | undefined];
    if ((provider !== "claude" && provider !== "codex") || !sessionId) return null;

    for (const [workspaceKey, sessions] of this.ws.sessions) {
      if (!workspaceKey.startsWith(`${provider}:`)) continue;
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) continue;
      return {
        session,
        workspacePath: workspaceKey.slice(workspaceKey.indexOf(":") + 1),
      };
    }
    return null;
  }

  private _linkPendingTabsFromSnapshot(workspacePath: string, provider: SessionProvider, sessions: Session[], oldSessions: Session[]) {
    const oldIds = new Set(oldSessions.map((s) => s.id));
    const newSessions = sessions.filter((s) => !oldIds.has(s.id));
    if (newSessions.length === 0) return;

    for (const [tabId, pending] of this.pendingSessionTabs) {
      if (pending.linkedSessionId) continue;
      if (pending.workspacePath !== workspacePath) continue;
      if (pending.provider !== provider) continue;
      const match = this._findSessionForPendingSession(pending, sessions);
      if (match) this._linkPendingSessionTab(tabId, pending, match);
    }
  }

  private _syncActiveSessionIds() {
    this.activeSessionIds.clear();
    for (const tab of this.tabs.tabsMap.values()) {
      if (tab.sessionId) this.activeSessionIds.add(tab.sessionId);
    }
  }

  private _syncFocusedSessionId() {
    const activeTab = this.tabs.getActiveTab();
    this.focusedSessionId = activeTab?.sessionId || null;
  }

  private _buildAppState(windowState?: SavedWindowState): SavedAppState {
    const tabs: SavedTabState[] = [];
    for (const tabId of this.tabs.getTabOrder()) {
      const tab = this.tabs.tabsMap.get(tabId);
      if (!tab || !tab.closable || tabId === START_TAB_ID) continue;

      const kind = tab.sessionId ? "session" : tab.restoreKind || "terminal";
      if (kind === "terminal") continue;
      if (kind === "session" && (!tab.sessionId || !tab.sessionProvider)) continue;
      if (kind === "new-session" && (!tab.sessionProvider || !tab.workspacePath)) continue;

      tabs.push({
        id: tab.id,
        kind,
        title: tab.title,
        cwd: tab.cwd,
        workspacePath: tab.workspacePath,
        sessionProvider: tab.sessionProvider,
        sessionId: tab.sessionId,
        shell: tab.shell,
      });
    }

    return {
      version: 1,
      activeTabId: this.tabs.activeId || undefined,
      selectedWorkspace: this.selectedWorkspace,
      selectedProvider: this.ws.selectedProvider,
      window: windowState,
      tabs,
    };
  }

  private async _readWindowState(): Promise<SavedWindowState | undefined> {
    try {
      const win = getCurrentWebviewWindow();
      const [position, size, maximized] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.isMaximized(),
      ]);
      return {
        x: Math.round(position.x),
        y: Math.round(position.y),
        width: Math.round(size.width),
        height: Math.round(size.height),
        maximized,
      };
    } catch (e) {
      console.warn("[Shelf] read window state failed:", e);
      return undefined;
    }
  }

  private async _saveAppStateNow() {
    if (!this.appStateReady || this.restoreInProgress) return;
    const state = this._buildAppState(await this._readWindowState() || this.restoredState?.window);
    try {
      await tauriInvoke("save_app_state", { state });
      this.restoredState = state;
    } catch (e) {
      console.warn("[Shelf] save app state failed:", e);
    }
  }

  private _scheduleSaveAppState(delay = 300) {
    if (!this.appStateReady || this.restoreInProgress) return;
    if (this.saveStateTimer) clearTimeout(this.saveStateTimer);
    this.saveStateTimer = setTimeout(() => {
      this.saveStateTimer = null;
      this._saveAppStateNow();
    }, delay);
  }

  private _setupWindowStateTracking() {
    const win = getCurrentWebviewWindow();
    win.onMoved(() => this._scheduleSaveAppState()).catch((e) => console.warn("[Shelf] window move tracking failed:", e));
    win.onResized(() => {
      const tab = this.tabs.getActiveTab();
      if (tab) scheduleTerminalRefit(tab);
      this._scheduleSaveAppState();
    }).catch((e) => console.warn("[Shelf] window resize tracking failed:", e));
  }

  private async _restoreSavedTabs() {
    const state = this.restoredState;
    if (!state || state.tabs.length === 0) {
      this._scheduleSaveAppState();
      return;
    }

    this.restoreInProgress = true;
    try {
      for (const saved of state.tabs) {
        if (this.tabs.tabsMap.has(saved.id) || saved.id === START_TAB_ID) continue;
        const tab = this._createRestoredTab(saved);
        if (tab) this.tabs.addTab(tab, false);
      }

      if (this.tabs.getTabOrder().some((id) => id !== START_TAB_ID)) {
        const start = this.tabs.tabsMap.get(START_TAB_ID);
        if (start) {
          start.containerEl.style.visibility = "hidden";
          start.containerEl.style.pointerEvents = "none";
          start.active = false;
        }
      }

      const restoredTabIds = this.tabs.getTabOrder().filter((id) => id !== START_TAB_ID);
      const activeId = state.activeTabId && state.activeTabId !== START_TAB_ID && this.tabs.tabsMap.has(state.activeTabId)
        ? state.activeTabId
        : restoredTabIds[0];
      if (activeId) {
        this.tabs.activateTab(activeId);
      } else {
        this._showStartPage();
      }

      this.selectedWorkspace = state.selectedWorkspace || this.tabs.getActiveTab()?.workspacePath || null;
      this.ws.selectedWorkspace = this.selectedWorkspace;
      this.ws.selectedProvider = state.selectedProvider || this.tabs.getActiveTab()?.sessionProvider || null;
    } finally {
      this.restoreInProgress = false;
      this._syncActiveSessionIds();
      this._syncFocusedSessionId();
      this._renderTabs();
      this._renderWorkspaces();
      this._scheduleSaveAppState();
    }
  }

  private _createRestoredTab(saved: SavedTabState): TabInfo | null {
    if (saved.kind === "session") {
      if (!saved.sessionId || !saved.sessionProvider || !saved.workspacePath) return null;
      const session = this.ws.getSessions(saved.workspacePath, saved.sessionProvider)
        .find((item) => item.id === saved.sessionId);
      if (!session) return null;
      const cwd = session.cwd || saved.cwd || saved.workspacePath;
      const command = session.provider === "codex"
        ? { bin: this.codexPath, args: ["resume", session.id, "-C", cwd] }
        : { bin: this.claudePath, args: ["--resume", session.id] };
      return createTerminalTab(saved.id, this._displayTitleForSession(session) || saved.title, this.terminalContainer,
        (id, data) => this._writePty(id, data),
        { sessionId: session.id, sessionProvider: session.provider, cwd, workspacePath: saved.workspacePath, command, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
      );
    }

    if (saved.kind === "new-session") {
      if (!saved.sessionProvider || !saved.workspacePath) return null;
      const command = saved.sessionProvider === "codex"
        ? { bin: this.codexPath, args: ["-C", saved.workspacePath] }
        : { bin: this.claudePath, args: [] };
      const title = saved.title || (saved.sessionProvider === "codex" ? t("tab.codex_new") : t("tab.claude_new"));
      const tab = createTerminalTab(saved.id, title, this.terminalContainer,
        (id, data) => this._writePty(id, data),
        { cwd: saved.workspacePath, workspacePath: saved.workspacePath, sessionProvider: saved.sessionProvider, command, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
      );
      this.pendingSessionTabs.set(saved.id, {
        workspacePath: saved.workspacePath,
        provider: saved.sessionProvider,
        baselineIds: new Set(this.ws.getSessions(saved.workspacePath, saved.sessionProvider).map((session) => session.id)),
        startedAt: Date.now(),
      });
      this._schedulePendingSessionPoll(saved.id);
      return tab;
    }

    return createTerminalTab(saved.id, saved.title || t("tab.terminal"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      {
        cwd: saved.cwd,
        workspacePath: saved.workspacePath,
        sessionProvider: saved.sessionProvider,
        shell: saved.shell || this.shellSetting,
        onUnreadChange: (id, v) => this._onUnreadChange(id, v),
      },
    );
  }

  private async _showSettings() {
    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.innerHTML = `
      <div class="settings-title">${t("settings.title")}</div>
      <div class="settings-section-title">${t("settings.general_title")}</div>
      <div class="settings-row"><label>${t("settings.shell")}</label><select id="settings-shell"></select></div>
      <div class="settings-row"><label>${t("settings.language")}</label>
        <select id="settings-lang">
          <option value="en">${t("settings.language_en")}</option>
          <option value="zh">${t("settings.language_zh")}</option>
        </select>
      </div>
      <div class="settings-row"><label>${t("settings.theme")}</label>
        <select id="settings-theme">
          <option value="dark">${t("settings.theme_dark")}</option>
          <option value="light">${t("settings.theme_light")}</option>
          <option value="github-light">${t("settings.theme_github_light")}</option>
          <option value="solarized-light">${t("settings.theme_solarized_light")}</option>
          <option value="dracula">${t("settings.theme_dracula")}</option>
          <option value="monokai">${t("settings.theme_monokai")}</option>
        </select>
      </div>
      <div class="settings-section-title">${t("settings.ai_title")}</div>
      <div class="settings-note">${t("settings.ai_help")}</div>
      <div class="settings-row stacked">
        <label for="settings-ai-base-url">${t("settings.ai_base_url")}</label>
        <input id="settings-ai-base-url" placeholder="https://api.openai.com/v1">
      </div>
      <div class="settings-row stacked">
        <label for="settings-ai-api-key">${t("settings.ai_api_key")}</label>
        <input id="settings-ai-api-key" type="password" placeholder="sk-...">
      </div>
      <div class="settings-row stacked">
        <label for="settings-ai-model">${t("settings.ai_model")}</label>
        <div class="settings-inline-actions">
          <input id="settings-ai-model" placeholder="${t("settings.ai_model_placeholder")}">
          <button id="settings-ai-load-models" type="button">${t("settings.ai_load_models")}</button>
        </div>
        <div class="settings-model-list hidden" id="settings-ai-model-list"></div>
        <div class="settings-status" id="settings-ai-model-status"></div>
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

    try {
      const [data, aiSettings] = await Promise.all([
        tauriInvoke<any>("detect_terminals"),
        tauriInvoke<AiSettings>("get_ai_settings"),
      ]);
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
      const themeSel = panel.querySelector("#settings-theme") as HTMLSelectElement;
      themeSel.value = this.theme;
      (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value = aiSettings.baseUrl || "";
      (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value = aiSettings.apiKey || "";
      (panel.querySelector("#settings-ai-model") as HTMLInputElement).value = aiSettings.model || "";
    } catch (e) {
      console.error("load_settings failed:", e);
    }

    panel.querySelector("#settings-ai-load-models")!.addEventListener("click", () => this._loadAiModelsForSettings(panel));

    panel.querySelector("#settings-save")!.addEventListener("click", async () => {
      this.shellSetting = (panel.querySelector("#settings-shell") as HTMLSelectElement).value;
      const newLang = (panel.querySelector("#settings-lang") as HTMLSelectElement).value;
      const selectedTheme = (panel.querySelector("#settings-theme") as HTMLSelectElement).value as AppTheme;
      const newTheme = APP_THEMES.has(selectedTheme) ? selectedTheme : "dark";
      setLang(newLang);
      this._setTheme(newTheme);
      const aiSettings: AiSettings = {
        baseUrl: (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value.trim(),
        apiKey: (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value.trim(),
        model: (panel.querySelector("#settings-ai-model") as HTMLInputElement).value.trim(),
      };
      try {
        await Promise.all([
          tauriInvoke("save_settings", { settings: { shell: this.shellSetting, language: newLang } }),
          tauriInvoke("save_ai_settings", { settings: aiSettings }),
        ]);
      } catch (e) {
        console.error("save_settings failed:", e);
      }
      close();
      this._updateStaticTexts();
      this._createStartTab();
      this._renderWorkspaces();
      this._scheduleSaveAppState();
    });
    panel.querySelector("#settings-cancel")!.addEventListener("click", close);
  }

  private async _loadAiModelsForSettings(panel: HTMLElement) {
    const status = panel.querySelector("#settings-ai-model-status") as HTMLElement | null;
    const list = panel.querySelector("#settings-ai-model-list") as HTMLElement | null;
    const loadButton = panel.querySelector("#settings-ai-load-models") as HTMLButtonElement | null;
    if (!status || !list || !loadButton) return;

    const settings: AiSettings = {
      baseUrl: (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value.trim(),
      apiKey: (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value.trim(),
      model: (panel.querySelector("#settings-ai-model") as HTMLInputElement).value.trim(),
    };

    loadButton.disabled = true;
    status.className = "settings-status";
    status.textContent = t("settings.ai_loading_models");
    try {
      const response = await tauriInvoke<AiModelListResponse>("list_ai_models", { settings });
      const baseUrlInput = panel.querySelector("#settings-ai-base-url") as HTMLInputElement;
      const modelInput = panel.querySelector("#settings-ai-model") as HTMLInputElement;
      baseUrlInput.value = response.baseUrl;
      this._renderAiModelList(list, modelInput, response.models);
      if (!modelInput.value && response.models.length > 0) {
        modelInput.value = response.models[0];
      }
      status.className = "settings-status success";
      status.textContent = t("settings.ai_models_loaded", String(response.models.length), response.baseUrl);
    } catch (e) {
      status.className = "settings-status error";
      status.textContent = t("settings.ai_models_failed", String(e));
    } finally {
      loadButton.disabled = false;
    }
  }

  private _renderAiModelList(list: HTMLElement, modelInput: HTMLInputElement, models: string[]) {
    list.innerHTML = "";
    list.classList.toggle("hidden", models.length === 0);
    for (const model of models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "settings-model-item";
      item.textContent = model;
      item.addEventListener("click", () => {
        modelInput.value = model;
        for (const sibling of list.querySelectorAll(".settings-model-item.selected")) {
          sibling.classList.remove("selected");
        }
        item.classList.add("selected");
        modelInput.focus();
      });
      if (modelInput.value === model) item.classList.add("selected");
      list.appendChild(item);
    }
  }

  private _toggleAiWindow() {
    if (this.aiWindowEl) {
      const hidden = this.aiWindowEl.classList.toggle("hidden");
      this.aiBtn.classList.toggle("active", !hidden);
      return;
    }
    this._createAiWindow();
    this.aiBtn.classList.add("active");
  }

  private _createAiWindow() {
    const panel = document.createElement("div");
    panel.className = "ai-window";
    panel.innerHTML = `
      <div class="ai-window-header">
        <div class="ai-window-title"><i data-lucide="bot"></i><span>${t("ai.title")}</span></div>
        <div class="ai-window-actions">
          <label class="ai-trust-toggle" title="${t("ai.shell_trust_hint")}">
            <input id="ai-shell-trust" type="checkbox">
            <span>${t("ai.shell_trust")}</span>
          </label>
          <button class="ai-icon-btn" id="ai-clear" title="${t("ai.clear")}"><i data-lucide="trash-2"></i></button>
          <button class="ai-icon-btn" id="ai-close" title="${t("ai.close")}"><i data-lucide="x"></i></button>
        </div>
      </div>
      <div class="ai-window-body">
        <div class="ai-log" id="ai-log"></div>
        <div class="ai-compose">
          <textarea id="ai-input" placeholder="${t("ai.placeholder")}"></textarea>
          <button class="ai-send-btn" id="ai-send">${t("ai.send")}</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    this.aiWindowEl = panel;
    this.aiLogEl = panel.querySelector("#ai-log") as HTMLElement;
    this.aiInputEl = panel.querySelector("#ai-input") as HTMLTextAreaElement;
    const trustToggle = panel.querySelector("#ai-shell-trust") as HTMLInputElement | null;
    if (trustToggle) {
      trustToggle.checked = this.aiShellAutoApprove;
      trustToggle.addEventListener("change", () => {
        this.aiShellAutoApprove = trustToggle.checked;
      });
    }

    panel.querySelector("#ai-close")!.addEventListener("click", () => {
      panel.classList.add("hidden");
      this.aiBtn.classList.remove("active");
    });
    panel.querySelector("#ai-clear")!.addEventListener("click", () => this._clearAiHistory());
    panel.querySelector("#ai-send")!.addEventListener("click", () => {
      if (this.aiBusy) this._stopAiRun();
      else this._sendAiMessage();
    });
    this.aiInputEl.addEventListener("compositionstart", () => { this.aiInputComposing = true; });
    this.aiInputEl.addEventListener("compositionend", () => { this.aiInputComposing = false; });
    this.aiInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !this.aiInputComposing && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this._sendAiMessage();
      }
    });
    this._setupAiWindowDragging(panel);
    this._appendAiMessage("system", t("ai.intro"));
    refreshIcons();
  }

  private _setupAiWindowDragging(panel: HTMLElement) {
    const header = panel.querySelector(".ai-window-header") as HTMLElement | null;
    if (!header) return;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const nextLeft = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, startLeft + e.clientX - startX));
      const nextTop = Math.max(44, Math.min(window.innerHeight - panel.offsetHeight - 8, startTop + e.clientY - startY));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.right = "auto";
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    header.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      dragging = true;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  private async _sendAiMessage() {
    if (this.aiBusy || !this.aiInputEl) return;
    const message = this.aiInputEl.value.trim();
    if (!message) return;
    this.aiInputEl.value = "";
    this._appendAiMessage("user", message);
    const history = this.aiHistory.slice();
    this.aiHistory.push({ role: "user", content: message });
    await this._runAiTurn(message, history, true);
  }

  private async _stopAiRun() {
    if (!this.aiBusy) return;
    try {
      await tauriInvoke("stop_ai_organizer");
      this._setAiSending(false);
    } catch (e) {
      console.error("[Shelf] stop AI failed:", e);
    }
  }

  private async _runAiTurn(message: string, history: AiHistoryMessage[], rollbackUserOnError = false) {
    this.aiStreamAssistantMsg = null;
    this.aiStreamTools.clear();
    this.aiBusy = true;
    this.aiPendingShellApproval = false;
    this._setAiSending(true);

    try {
      await this._listenToAiStream();
      const active = this.tabs.getActiveTab();
      const response = await tauriInvoke<AiRunResponse>("run_ai_organizer", {
        request: {
          message,
          history,
          workspacePath: this.selectedWorkspace || active?.workspacePath || null,
          provider: active?.sessionProvider || this.ws.selectedProvider || null,
          shellAutoApprove: this.aiShellAutoApprove,
        },
      });
      this.aiSessionMap = response.map;
      if (!this.aiStreamAssistantMsg && response.message) {
        this._appendAiTextDelta(response.message);
      }
      this._renderTabs();
      this._renderWorkspaces();
    } catch (e) {
      if (this._isShellApprovalInterrupt(e)) {
        this.aiPendingShellApproval = true;
      } else if (this._isAiCancelled(e)) {
        this._appendAiMessage("system", t("ai.stopped"));
      } else {
        if (rollbackUserOnError) this.aiHistory.pop();
        this._appendAiMessage("assistant", t("ai.failed", String(e)));
      }
    } finally {
      this._stopAiStreamListener();
      this.aiStreamAssistantMsg = null;
      this.aiBusy = false;
      this._setAiSending(false);
    }
  }

  private _isShellApprovalInterrupt(error: unknown): boolean {
    return String(error).includes("SHELF_SHELL_APPROVAL_REQUIRED:");
  }

  private _isAiCancelled(error: unknown): boolean {
    return String(error).includes("SHELF_AI_CANCELLED:");
  }

  private _setAiSending(sending: boolean) {
    const send = this.aiWindowEl?.querySelector("#ai-send") as HTMLButtonElement | null;
    const clear = this.aiWindowEl?.querySelector("#ai-clear") as HTMLButtonElement | null;
    if (send) {
      send.disabled = false;
      send.classList.toggle("stop", sending);
      send.textContent = sending ? t("ai.stop") : t("ai.send");
    }
    if (clear) clear.disabled = sending;
  }

  private _appendAiMessage(role: "user" | "assistant" | "system", text: string): HTMLElement {
    if (!this.aiLogEl) return document.createElement("div");
    const msg = document.createElement("div");
    msg.className = `ai-msg ${role}`;
    msg.textContent = text;
    this.aiLogEl.appendChild(msg);
    this.aiLogEl.scrollTop = this.aiLogEl.scrollHeight;
    return msg;
  }

  private async _listenToAiStream() {
    this._stopAiStreamListener();
    this.aiStreamUnlisten = await listen<AiStreamEvent>("shelf://ai-stream", (event) => {
      const payload = event.payload;
      if (payload.kind === "text" && payload.text) {
        this._appendAiTextDelta(payload.text);
      } else if (payload.kind === "tool-start") {
        this._appendAiToolCall(payload.id || crypto.randomUUID(), payload.tool || "tool", payload.text || "");
      } else if (payload.kind === "tool-end") {
        this._finishAiToolCall(payload.id || "", payload.tool || "tool", payload.text || "");
      } else if (payload.kind === "tool-result") {
        this._setAiToolResult(payload.id || "", payload.text || "");
      } else if (payload.kind === "shell-approval") {
        this._showShellApproval(payload.id || "", payload.tool || "run_shell_command", payload.text || "");
      } else if (payload.kind === "error" && payload.text) {
        this._appendAiMessage("assistant", payload.text);
      }
    });
  }

  private _stopAiStreamListener() {
    if (!this.aiStreamUnlisten) return;
    this.aiStreamUnlisten();
    this.aiStreamUnlisten = null;
  }

  private _appendAiTextDelta(text: string) {
    const target = this._ensureStreamingAssistantMessage();
    const textEl = this._ensureAiTextEl(target);
    textEl.textContent = `${textEl.textContent || ""}${text}`;
    this._syncStreamingAssistantHistory(textEl.textContent || "");
    if (this.aiLogEl) this.aiLogEl.scrollTop = this.aiLogEl.scrollHeight;
  }

  private _syncStreamingAssistantHistory(content: string) {
    const last = this.aiHistory[this.aiHistory.length - 1];
    if (last?.role === "assistant") {
      last.content = content;
    } else {
      this.aiHistory.push({ role: "assistant", content });
    }
  }

  private _ensureStreamingAssistantMessage(): HTMLElement {
    if (!this.aiStreamAssistantMsg) {
      this.aiStreamAssistantMsg = this._appendAiMessage("assistant", "");
    }
    return this.aiStreamAssistantMsg;
  }

  private _ensureAiTextEl(target: HTMLElement): HTMLElement {
    let textEl = target.querySelector(".ai-msg-text") as HTMLElement | null;
    if (!textEl) {
      textEl = document.createElement("div");
      textEl.className = "ai-msg-text";
      const textNodes = Array.from(target.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
      textEl.textContent = textNodes.map((node) => node.textContent || "").join("");
      for (const node of textNodes) node.remove();
      target.appendChild(textEl);
    }
    return textEl;
  }

  private _clearAiHistory() {
    if (this.aiBusy || !this.aiLogEl) return;
    this.aiHistory = [];
    this.aiLogEl.innerHTML = "";
  }

  private _appendAiToolCall(id: string, tool: string, args: string) {
    if (!this.aiLogEl) return;
    this.aiStreamAssistantMsg = null;
    const msg = document.createElement("div");
    msg.className = "ai-msg tool";
    msg.innerHTML = `
      <div class="ai-tool-header">
        <span class="ai-tool-name">${escapeHtml(tool)}</span>
        <span class="ai-tool-state">${escapeHtml(t("ai.tool_running"))}</span>
      </div>
      <details class="ai-tool-details">
        <summary>${escapeHtml(t("ai.tool_details"))}</summary>
        <pre><code class="ai-tool-json">${escapeHtml(this._formatJsonLike(args))}</code></pre>
      </details>`;
    this.aiLogEl.appendChild(msg);

    const toolMessage = {
      id,
      tool,
      el: msg,
      statusEl: msg.querySelector(".ai-tool-state") as HTMLElement,
      codeEl: msg.querySelector(".ai-tool-json") as HTMLElement,
      actionsEl: undefined,
    };
    this.aiStreamTools.set(id, toolMessage);
    this.aiLogEl.scrollTop = this.aiLogEl.scrollHeight;
  }

  private _finishAiToolCall(id: string, tool: string, result: string) {
    const toolMessage = this._getOrCreateToolMessage(id, tool);
    toolMessage.statusEl.textContent = t("ai.tool_done");
    toolMessage.el.classList.add("done");
    if (result) {
      toolMessage.codeEl.textContent = this._formatJsonLike(result);
      this._recordAiToolHistory(tool, result);
    }
    if (this.aiLogEl) this.aiLogEl.scrollTop = this.aiLogEl.scrollHeight;
  }

  private _setAiToolResult(id: string, result: string) {
    const toolMessage = this._getOrCreateToolMessage(id, "tool");
    if (result) {
      toolMessage.codeEl.textContent = this._formatJsonLike(result);
      this._recordAiToolHistory(toolMessage.tool, result);
    }
    if (this.aiLogEl) this.aiLogEl.scrollTop = this.aiLogEl.scrollHeight;
  }

  private _recordAiToolHistory(tool: string, content: string) {
    const last = this.aiHistory[this.aiHistory.length - 1];
    if (last?.role === "tool" && last.tool === tool && last.content === content) return;
    this.aiHistory.push({ role: "tool", tool, content });
  }

  private _showShellApproval(id: string, tool: string, value: string) {
    const approval = this._parseShellApproval(value);
    if (!approval) return;
    const toolMessage = this._getOrCreateToolMessage(id, tool);
    toolMessage.approval = approval;
    toolMessage.statusEl.textContent = t("ai.shell_approval_required");
    toolMessage.el.classList.add("approval");
    toolMessage.codeEl.textContent = this._formatJsonLike(JSON.stringify(approval));

    let actions = toolMessage.actionsEl;
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "ai-tool-actions";
      toolMessage.el.appendChild(actions);
      toolMessage.actionsEl = actions;
    }
    actions.innerHTML = `
      <button class="ai-tool-approve" title="${escapeHtml(t("ai.shell_approve"))}">✓</button>
      <button class="ai-tool-deny" title="${escapeHtml(t("ai.shell_deny"))}">×</button>`;
    actions.querySelector(".ai-tool-approve")!.addEventListener("click", () => this._approveShellCommand(toolMessage));
    actions.querySelector(".ai-tool-deny")!.addEventListener("click", () => this._denyShellCommand(toolMessage));
    if (this.aiLogEl) this.aiLogEl.scrollTop = this.aiLogEl.scrollHeight;
  }

  private _parseShellApproval(value: string): ShellCommandApproval | null {
    try {
      return JSON.parse(value) as ShellCommandApproval;
    } catch (_) {
      return null;
    }
  }

  private async _approveShellCommand(toolMessage: AiToolMessage) {
    if (!toolMessage.approval || this.aiBusy) return;
    const approval = toolMessage.approval;
    toolMessage.statusEl.textContent = t("ai.shell_running");
    toolMessage.actionsEl?.querySelectorAll("button").forEach((button) => {
      (button as HTMLButtonElement).disabled = true;
    });
    try {
      const result = await tauriInvoke<unknown>("execute_approved_shell_command", {
        args: {
          command: approval.command,
          cwd: approval.cwd,
          timeoutMs: approval.timeoutMs,
          maxBytes: approval.maxBytes,
          maxLines: approval.maxLines,
          approved: true,
        },
      });
      const resultText = JSON.stringify(result, null, 2);
      toolMessage.statusEl.textContent = t("ai.tool_done");
      toolMessage.el.classList.add("done");
      toolMessage.actionsEl?.remove();
      toolMessage.actionsEl = undefined;
      toolMessage.codeEl.textContent = resultText;
      this._recordAiToolHistory(toolMessage.tool, resultText);
      await this._continueAfterToolResult();
    } catch (e) {
      toolMessage.statusEl.textContent = t("ai.failed", String(e));
      toolMessage.el.classList.add("error");
      toolMessage.actionsEl?.querySelectorAll("button").forEach((button) => {
        (button as HTMLButtonElement).disabled = false;
      });
    }
  }

  private _denyShellCommand(toolMessage: AiToolMessage) {
    toolMessage.statusEl.textContent = t("ai.shell_denied");
    toolMessage.el.classList.add("denied");
    toolMessage.actionsEl?.remove();
    toolMessage.actionsEl = undefined;
    this.aiPendingShellApproval = false;
  }

  private async _continueAfterToolResult() {
    this.aiPendingShellApproval = false;
    const history = this.aiHistory.slice();
    const message = "Continue from the approved shell command result.";
    await this._runAiTurn(message, history, false);
  }

  private _getOrCreateToolMessage(id: string, tool: string): AiToolMessage {
    const existing = this.aiStreamTools.get(id);
    if (existing) return existing;
    const fallbackId = id || crypto.randomUUID();
    this._appendAiToolCall(fallbackId, tool, "");
    return this.aiStreamTools.get(fallbackId)!;
  }

  private _formatJsonLike(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch (_) {
      return value;
    }
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
        await tauriInvoke("rename_session", { sessionId: session.id, newTitle: newName, provider: session.provider });
        console.log("[Shelf] rename_session OK, refreshing...");
        for (const ws of this.ws.workspaces) await this._refreshWorkspaceSessions(ws.path, ws.provider, "rename");
      } catch (e) { console.error("Rename failed:", e); }
      close();
    };
    panel.querySelector("#rename-save")!.addEventListener("click", doSave);
    panel.querySelector("#rename-cancel")!.addEventListener("click", close);
  }

  private async _deleteSession(session: Session, wsPath: string) {
    try {
      await tauriInvoke("delete_session", { sessionId: session.id, provider: session.provider });
      this.activeSessionIds.delete(session.id);
      if (this.focusedSessionId === session.id) this.focusedSessionId = null;
      for (const [id, tab] of this.tabs.tabsMap) {
        if (tab.sessionId === session.id && tab.sessionProvider === session.provider) this.tabs.closeTab(id);
      }
      await this._refreshWorkspaceSessions(wsPath, session.provider, "delete");
      this._showToast(t("toast.deleted"));
      this._scheduleSaveAppState();
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
    const baselineIds = await this._sessionBaselineIds(wsPath, "claude");
    const tab = createTerminalTab(tabId, t("tab.claude_new"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd: wsPath, workspacePath: wsPath, sessionProvider: "claude", command: { bin: this.claudePath, args: [] }, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
    );
    this.tabs.addTab(tab);
    this.pendingSessionTabs.set(tabId, {
      workspacePath: wsPath,
      provider: "claude",
      baselineIds,
      startedAt: Date.now(),
    });
    this._schedulePendingSessionPoll(tabId);
    this._scheduleSaveAppState();
  }

  private async _newCodexSession(wsPath: string) {
    const tabId = crypto.randomUUID();
    const baselineIds = await this._sessionBaselineIds(wsPath, "codex");
    const tab = createTerminalTab(tabId, t("tab.codex_new"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd: wsPath, workspacePath: wsPath, sessionProvider: "codex", command: { bin: this.codexPath, args: ["-C", wsPath] }, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
    );
    this.tabs.addTab(tab);
    this.pendingSessionTabs.set(tabId, {
      workspacePath: wsPath,
      provider: "codex",
      baselineIds,
      startedAt: Date.now(),
    });
    this._schedulePendingSessionPoll(tabId);
    this._scheduleSaveAppState();
  }

  private async _sessionBaselineIds(wsPath: string, provider: SessionProvider): Promise<Set<string>> {
    let baselineSessions = this.ws.getSessions(wsPath, provider);
    try {
      const result = await this._refreshWorkspaceSessions(wsPath, provider, "new-session");
      baselineSessions = result.sessions;
    } catch (_) {
      /* keep existing cache as best-effort baseline */
    }
    return new Set(baselineSessions.map((session) => session.id));
  }

  private _schedulePendingSessionPoll(tabId: string) {
    const pending = this.pendingSessionTabs.get(tabId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this._pollPendingSessionTab(tabId).catch((error) => {
        console.warn("[Shelf] pending session poll failed:", error);
        if (this._pendingSessionPollExpired(tabId)) {
          this._clearPendingSessionTab(tabId);
          return;
        }
        this._schedulePendingSessionPoll(tabId);
      });
    }, PENDING_SESSION_POLL_INTERVAL_MS);
  }

  private _pendingSessionPollExpired(tabId: string): boolean {
    const pending = this.pendingSessionTabs.get(tabId);
    if (!pending) return true;
    const tab = this.tabs.tabsMap.get(tabId);
    const now = Date.now();
    if (pending.linkedSessionId) return !!pending.stableUntil && now >= pending.stableUntil;
    if (tab && !tab.ptyExited) return false;
    return now - pending.startedAt > PENDING_SESSION_DISCOVERY_TIMEOUT_MS;
  }

  private async _pollPendingSessionTab(tabId: string) {
    const pending = this.pendingSessionTabs.get(tabId);
    const tab = this.tabs.tabsMap.get(tabId);
    if (!pending || !tab) {
      this._clearPendingSessionTab(tabId);
      return;
    }

    const { sessions } = await this._refreshWorkspaceSessions(pending.workspacePath, pending.provider, "new-session");
    const now = Date.now();

    if (!pending.linkedSessionId) {
      const session = this._findSessionForPendingSession(pending, sessions);
      if (session) {
        this._linkPendingSessionTab(tabId, pending, session);
      }
    } else {
      const session = sessions.find((item) => item.id === pending.linkedSessionId);
      if (session && tab.title !== this._displayTitleForSession(session)) {
        tab.title = this._displayTitleForSession(session);
        pending.stableUntil = Date.now() + PENDING_SESSION_STABILIZE_MS;
        this._renderTabs();
      }
    }

    const latest = this.pendingSessionTabs.get(tabId);
    if (!latest) return;
    if (!latest.linkedSessionId && this._pendingSessionPollExpired(tabId)) {
      this._clearPendingSessionTab(tabId);
      return;
    }
    if (latest.linkedSessionId && latest.stableUntil && now >= latest.stableUntil) {
      this._clearPendingSessionTab(tabId);
      return;
    }
    this._schedulePendingSessionPoll(tabId);
  }

  private _findSessionForPendingSession(pending: PendingSessionTab, sessions: Session[]): Session | undefined {
    const claimedSessionIds = new Set(
      Array.from(this.pendingSessionTabs.values())
        .map((item) => item.linkedSessionId)
        .filter((id): id is string => !!id && id !== pending.linkedSessionId),
    );
    const candidates = sessions.filter((session) => (
      !pending.baselineIds.has(session.id) &&
      !claimedSessionIds.has(session.id)
    ));
    if (candidates.length === 0) return undefined;
    const workspaceCandidates = candidates.filter((session) => (
      !session.cwd ||
      session.cwd === pending.workspacePath ||
      session.cwd.startsWith(pending.workspacePath + "/")
    ));
    return (workspaceCandidates.length > 0 ? workspaceCandidates : candidates)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  }

  private _linkPendingSessionTab(tabId: string, pending: PendingSessionTab, session: Session) {
    const tab = this.tabs.tabsMap.get(tabId);
    if (!tab) {
      this._clearPendingSessionTab(tabId);
      return;
    }

    pending.linkedSessionId = session.id;
    pending.stableUntil = Date.now() + PENDING_SESSION_STABILIZE_MS;
    tab.sessionId = session.id;
    tab.title = this._displayTitleForSession(session);
    this.activeSessionIds.add(session.id);
    if (this.tabs.activeId === tabId) this.focusedSessionId = session.id;
    this.selectedWorkspace = pending.workspacePath;
    this.ws.selectedWorkspace = pending.workspacePath;
    this.ws.selectedProvider = pending.provider;
    this.ws.expandedProviders.add(pending.provider);
    this.ws.expandedWorkspaces.add(this.ws.workspaceKey(pending.workspacePath, pending.provider));
    this._renderTabs();
    this._renderWorkspaces();
    this._scheduleSaveAppState();
  }

  private _clearPendingSessionTab(tabId: string) {
    const pending = this.pendingSessionTabs.get(tabId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pendingSessionTabs.delete(tabId);
  }

  private async _refreshAllSessions() {
    this.refreshBtn.classList.add("spinning");
    try {
      for (const ws of this.ws.workspaces) {
        await this._refreshWorkspaceSessions(ws.path, ws.provider, "manual");
      }
    } finally {
      this.refreshBtn.classList.remove("spinning");
    }
  }

  private _createBlankTab(cwd?: string) {
    const tabId = crypto.randomUUID();
    let wsPath: string | undefined;
    let provider: SessionProvider | undefined;
    if (cwd) {
      const matches = this.ws.workspaces
        .filter((w) => cwd === w.path || cwd.startsWith(w.path + "/"))
        .sort((a, b) => {
          if (a.provider === this.ws.selectedProvider && b.provider !== this.ws.selectedProvider) return -1;
          if (b.provider === this.ws.selectedProvider && a.provider !== this.ws.selectedProvider) return 1;
          return b.path.length - a.path.length;
        });
      const match = matches[0];
      wsPath = match?.path;
      provider = match?.provider;
    }
    const tab = createTerminalTab(tabId, t("tab.terminal"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd, workspacePath: wsPath, sessionProvider: provider, shell: this.shellSetting, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
    );
    this.tabs.addTab(tab);
    this._scheduleSaveAppState();
  }

  private _openSessionTab(session: Session, wsPath: string) {
    console.log(`[Shelf] openSessionTab id=${session.id} title="${session.display_title}" tabs=${this.tabs.tabsMap.size}`);
    for (const [, tab] of this.tabs.tabsMap) {
      if (tab.sessionId === session.id && tab.sessionProvider === session.provider) {
        this.tabs.activateTab(tab.id);
        this._scheduleSaveAppState();
        return;
      }
    }
    const tabId = crypto.randomUUID();
    const cwd = session.cwd || wsPath;
    const command = session.provider === "codex"
      ? { bin: this.codexPath, args: ["resume", session.id, "-C", cwd] }
      : { bin: this.claudePath, args: ["--resume", session.id] };
    const tab = createTerminalTab(tabId, this._displayTitleForSession(session), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { sessionId: session.id, sessionProvider: session.provider, cwd, workspacePath: wsPath, command, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
    );
    this.tabs.addTab(tab);
    this.activeSessionIds.add(session.id);
    this.focusedSessionId = session.id;
    this._scheduleSaveAppState();
  }

  private _writePty(tabId: string, data: string) {
    const tab = this.tabs.tabsMap.get(tabId);
    if (tab?.sessionId && this.pendingSessionTabs.has(tabId)) {
      const pending = this.pendingSessionTabs.get(tabId);
      if (pending) pending.stableUntil = Date.now() + PENDING_SESSION_STABILIZE_MS;
    }
    if (tab) writeToPty(tab, data);
  }

  private _onActivateTab(tab: TabInfo) {
    this.focusedSessionId = tab.sessionId || null;
    this._syncActiveSessionIds();
    if (tab.workspacePath) {
      this.selectedWorkspace = tab.workspacePath;
      this.ws.selectedWorkspace = tab.workspacePath;
      this.ws.selectedProvider = tab.sessionProvider || null;
      if (tab.sessionProvider) {
        this.ws.expandedProviders.add(tab.sessionProvider);
        this.ws.expandedWorkspaces.add(this.ws.workspaceKey(tab.workspacePath, tab.sessionProvider));
      }
      this._loadFileTree(tab.workspacePath);
    }
    this._scheduleSaveAppState();
  }

  /** Called when a tab's unread state changes (background tab receives output). */
  private _onUnreadChange(_tabId: string, _hasUnread: boolean) {
    this._updateBadge();
    this._renderTabs();
  }

  /** Update the macOS Dock badge with the count of tabs with unread output. */
  private async _updateBadge() {
    let count = 0;
    this.tabs.tabsMap.forEach((tab) => {
      if (tab.hasUnreadOutput && tab.id !== "__start__") count++;
    });
    try {
      await getCurrentWebviewWindow().setBadgeCount(count);
    } catch {
      // Silently ignore if the platform doesn't support badge (e.g. Linux)
    }
  }

  private _onTerminalDrop(path: string) {
    const tab = this.tabs.getActiveTab();
    if (tab && tab.id !== START_TAB_ID && tab.pty) {
      this._clearPendingSessionTab(tab.id);
      writeToPty(tab, `'${path.replace(/'/g, "'\\''")}' `);
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
    this._scheduleSaveAppState();
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

  private _refreshCurrentFileTree() {
    const path = this.selectedWorkspace || this.tabs.getActiveTab()?.workspacePath;
    if (!path) return;
    clearFileCache();
    this._loadFileTree(path);
  }

  private _renderWorkspaces() {
    this.workspaceList.innerHTML = "";

    if (this.pinnedIds.size > 0) {
      const pinnedDiv = document.createElement("div");
      pinnedDiv.className = "pinned-section";
      pinnedDiv.innerHTML = `<div class="pinned-label"><i data-lucide="pin"></i> ${t("workspace.pinned")}</div>`;
      for (const ws of this.ws.workspaces) {
        const sessions = this.ws.getSessions(ws.path, ws.provider);
        for (const session of sessions) {
          if (!this.pinnedIds.has(session.id)) continue;
          const item = this._renderSessionItem(session, ws.path, true);
          item.classList.add("pinned-item");
          pinnedDiv.appendChild(item);
        }
      }
      this.workspaceList.appendChild(pinnedDiv);
    }

    this.workspaceList.appendChild(this._renderAiOrganizerGroup());
    this.workspaceList.appendChild(this._renderProviderGroup("claude", "Claude Code"));
    this.workspaceList.appendChild(this._renderProviderGroup("codex", "Codex"));
    refreshIcons();
  }

  private _renderAiOrganizerGroup(): HTMLElement {
    const group = document.createElement("div");
    group.className = "provider-section provider-root ai-organizer-root";
    const categories = this._aiCategories();
    const mappingCount = this._aiMappingEntries().length;

    const header = document.createElement("div");
    header.className = "provider-header provider-root-header ai-organizer-header";
    header.innerHTML = `
      <i data-lucide="chevron-right" class="provider-arrow${this.expandedAiOrganizer ? " expanded" : ""}"></i>
      <span class="provider-title">${escapeHtml(t("ai.organizer_section"))}</span>
      <span class="provider-count">${mappingCount}</span>`;
    header.addEventListener("click", () => {
      this.expandedAiOrganizer = !this.expandedAiOrganizer;
      this._renderWorkspaces();
    });
    group.appendChild(header);

    if (!this.expandedAiOrganizer) return group;

    if (categories.length === 0 || mappingCount === 0) return group;

    for (const category of categories) {
      const entries = this._aiMappingEntries(category.id);
      if (entries.length === 0) continue;
      group.appendChild(this._renderAiCategoryItem(category, entries));
    }

    return group;
  }

  private _aiCategories(): AiGroup[] {
    return Object.values(this.aiSessionMap.groups)
      .filter((group) => this._aiMappingEntries(group.id).length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  private _aiMappingEntries(categoryId?: string): Array<{ sessionKey: string; session: Session; workspacePath: string }> {
    const entries: Array<{ sessionKey: string; session: Session; workspacePath: string }> = [];
    for (const [sessionKey, meta] of Object.entries(this.aiSessionMap.sessions)) {
      if (!meta?.groupId) continue;
      if (categoryId && meta.groupId !== categoryId) continue;
      const resolved = this._findSessionByKey(sessionKey);
      if (!resolved) continue;
      entries.push({ sessionKey, ...resolved });
    }
    return entries.sort((a, b) => b.session.updated_at.localeCompare(a.session.updated_at));
  }

  private _renderAiCategoryItem(
    category: AiGroup,
    entries: Array<{ sessionKey: string; session: Session; workspacePath: string }>,
  ): HTMLElement {
    const categoryEl = document.createElement("div");
    categoryEl.className = "ai-category-item";
    const isExpanded = !this.collapsedAiCategories.has(category.id);

    const header = document.createElement("div");
    header.className = "workspace-header ai-category-header";
    header.innerHTML = `
      <i data-lucide="chevron-right" class="ws-arrow${isExpanded ? " expanded" : ""}"></i>
      <i data-lucide="${isExpanded ? "folder-open" : "folder"}"></i>
      <span class="ai-category-name" title="${escapeHtml(category.description || category.name)}">${escapeHtml(category.name)}</span>
      <span class="provider-count">${entries.length}</span>`;
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isExpanded) this.collapsedAiCategories.add(category.id);
      else this.collapsedAiCategories.delete(category.id);
      this._renderWorkspaces();
    });
    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: t("context.rename"), action: () => this._renameAiCategoryPrompt(category) },
        { label: t("context.delete"), action: () => this._deleteAiCategory(category.id) },
      ], e.clientX, e.clientY);
    });
    categoryEl.appendChild(header);

    if (isExpanded) {
      const sessionList = document.createElement("div");
      sessionList.className = "workspace-sessions show ai-category-sessions";
      for (const entry of entries) {
        sessionList.appendChild(this._renderAiMappedSessionItem(entry.sessionKey, entry.session, entry.workspacePath));
      }
      categoryEl.appendChild(sessionList);
    }
    return categoryEl;
  }

  private _renderAiMappedSessionItem(sessionKey: string, session: Session, wsPath: string): HTMLElement {
    const item = this._renderSessionItem(session, wsPath, true);
    item.classList.add("ai-mapped-session");
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        { label: t("context.rename"), action: () => this._renameSessionPrompt(session) },
        { label: t("ai.remove_mapping"), action: () => this._removeAiMapping(sessionKey) },
      ], e.clientX, e.clientY);
    });
    return item;
  }

  private _renameAiCategoryPrompt(category: AiGroup) {
    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.innerHTML = `
      <div class="settings-title">${t("ai.rename_category")}</div>
      <div class="settings-row">
        <input id="rename-input" value="${escapeHtml(category.name)}" style="flex:1;padding:6px 10px;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:13px;outline:none;" autofocus>
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
    const doSave = async () => {
      const nextName = input.value.trim();
      if (!nextName) return;
      const current = this.aiSessionMap.groups[category.id];
      if (!current) return close();
      this.aiSessionMap.groups[category.id] = { ...current, name: nextName };
      await this._saveAiSessionMap();
      close();
      this._renderWorkspaces();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
    panel.querySelector("#rename-save")!.addEventListener("click", doSave);
    panel.querySelector("#rename-cancel")!.addEventListener("click", close);
  }

  private async _deleteAiCategory(categoryId: string) {
    delete this.aiSessionMap.groups[categoryId];
    this.collapsedAiCategories.delete(categoryId);
    for (const [sessionKey, meta] of Object.entries(this.aiSessionMap.sessions)) {
      if (meta.groupId !== categoryId) continue;
      delete this.aiSessionMap.sessions[sessionKey];
    }
    await this._saveAiSessionMap();
    this._renderWorkspaces();
  }

  private async _removeAiMapping(sessionKey: string) {
    delete this.aiSessionMap.sessions[sessionKey];
    await this._saveAiSessionMap();
    this._renderWorkspaces();
  }

  private _renderProviderGroup(provider: SessionProvider, title: string): HTMLElement {
    const group = document.createElement("div");
    group.className = "provider-section provider-root";
    const workspaces = this.ws.workspaces.filter((workspace) => workspace.provider === provider);
    const isExpanded = this.ws.expandedProviders.has(provider);

    const header = document.createElement("div");
    header.className = "provider-header provider-root-header";
    header.innerHTML = `
      <i data-lucide="chevron-right" class="provider-arrow${isExpanded ? " expanded" : ""}"></i>
      <span class="provider-title">${escapeHtml(title)}</span>
      <span class="provider-count">${workspaces.length}</span>
      <button class="provider-new-btn" title="${t("workspace.add")}">+</button>`;
    header.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (this.ws.expandedProviders.has(provider)) this.ws.expandedProviders.delete(provider);
      else this.ws.expandedProviders.add(provider);
      this._renderWorkspaces();
    });
    header.querySelector(".provider-new-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.ws.promptAdd(provider);
    });
    group.appendChild(header);

    if (isExpanded) {
      for (const ws of workspaces) {
        group.appendChild(this._renderWorkspaceItem(ws));
      }
    }
    return group;
  }

  private _renderWorkspaceItem(ws: import("./types").WorkspaceItem): HTMLElement {
    const wsDiv = document.createElement("div");
    wsDiv.className = "workspace-item provider-workspace-item";
    const key = this.ws.workspaceKey(ws.path, ws.provider);
    const isSelected = this.selectedWorkspace === ws.path && this.ws.selectedProvider === ws.provider;
    const isExpanded = this.ws.expandedWorkspaces.has(key);
    const sessions = this.ws.getSessions(ws.path, ws.provider);
    const page = this.ws.sessionPages.get(key) || 1;
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
      const task = ws.provider === "claude"
        ? this._newClaudeSession(ws.path)
        : this._newCodexSession(ws.path);
      task.catch((error) => console.error("New session failed:", error));
    });
    const removeBtn = header.querySelector(".ws-remove-btn") as HTMLButtonElement;
    let deletePending = false;
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (deletePending) {
        const toClose: string[] = [];
        for (const [, tab] of this.tabs.tabsMap) {
          if (tab.workspacePath === ws.path && tab.sessionProvider === ws.provider && tab.closable) toClose.push(tab.id);
        }
        for (const id of toClose) {
          if (this.tabs.tabsMap.get(id)?.sessionId) {
            this.activeSessionIds.delete(this.tabs.tabsMap.get(id)!.sessionId!);
            this.focusedSessionId = null;
          }
          this._clearPendingSessionTab(id);
          this.tabs.closeTab(id);
        }
        this.ws.remove(ws.path, ws.provider); this._showStartPage();
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
      this._toggleWorkspaceExpansion(ws.path, ws.provider);
    });
    wsDiv.appendChild(header);

    if (isExpanded) {
      const sessionList = document.createElement("div");
      sessionList.className = "workspace-sessions show";
      for (const session of sessions.slice(0, pageEnd)) {
        sessionList.appendChild(this._renderSessionItem(session, ws.path));
      }
      if (pageEnd < sessions.length) {
        const remaining = sessions.length - pageEnd;
        const moreBtn = document.createElement("div");
        moreBtn.className = "session-load-more";
        moreBtn.textContent = `${t("session.load")} ${Math.min(remaining, SESSION_PAGE_SIZE)} ${t("session.load_more")} (${remaining} ${t("session.remaining")})`;
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.ws.sessionPages.set(key, page + 1);
          this._renderWorkspaces();
        });
        sessionList.appendChild(moreBtn);
      }
      wsDiv.appendChild(sessionList);
    }
    return wsDiv;
  }

  private _toggleWorkspaceExpansion(wsPath: string, provider: SessionProvider) {
    const key = this.ws.workspaceKey(wsPath, provider);
    const shouldExpand = !this.ws.expandedWorkspaces.has(key);

    if (shouldExpand) {
      this.ws.expandedProviders.add(provider);
      this.ws.expandedWorkspaces.add(key);
      if (!this.ws.sessions.has(key)) {
        this._refreshWorkspaceSessions(wsPath, provider, "manual")
          .catch((error) => console.error("Expand workspace scan failed:", error))
          .finally(() => this._renderWorkspaces());
      }
    } else {
      this.ws.expandedWorkspaces.delete(key);
    }

    this._renderWorkspaces();
  }

  private _renderSessionItem(session: Session, wsPath: string, showProviderBadge = false): HTMLElement {
    const isActive = this.activeSessionIds.has(session.id);
    const isFocused = this.focusedSessionId === session.id;
    const item = document.createElement("div");
    const badge = session.provider === "codex" ? "CX" : "CC";
    const title = this._displayTitleForSession(session);
    item.className = `session-item${isActive ? " active" : ""}${isFocused ? " focused" : ""}`;
    item.innerHTML = `
      <span class="dot-icon${isFocused ? " focused" : ""}"></span>
      <span class="session-title" title="${escapeHtml(session.display_title)}">${escapeHtml(title)}</span>
      ${showProviderBadge ? `<span class="provider-badge ${session.provider}">${badge}</span>` : ""}
      <span class="session-date">${formatDate(session.started_at)}</span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      this._openSessionTab(session, wsPath);
      this._renderWorkspaces();
    });
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isPinned = this.pinnedIds.has(session.id);
      const items = [
        { label: t("context.rename"), action: () => this._renameSessionPrompt(session) },
        { label: isPinned ? t("context.unpin") : t("context.pin"), action: () => this._togglePin(session) },
        { label: t("context.delete"), action: () => this._deleteSession(session, wsPath) },
      ];
      showContextMenu(items, e.clientX, e.clientY);
    });
    return item;
  }

  private _sortable: Sortable | null = null;
  private _tabSortInProgress = false;

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
      const closeHtml = tab.closable ? `<span class="tab-close" title="${t("tab.close")}"><i data-lucide="x"></i></span>` : "";
      tabEl.innerHTML = `
        <span class="tab-drag-handle">
          <span class="dot-icon${isTabActive ? " active" : ""}${tab.hasUnreadOutput ? " unread" : ""}"></span>
          <span class="tab-title">${escapeHtml(tab.title)}</span>
        </span>
        ${closeHtml}`;
      if (tab.closable) {
        tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tab.sessionId) {
            this.activeSessionIds.delete(tab.sessionId);
            if (this.focusedSessionId === tab.sessionId) this.focusedSessionId = null;
          }
          this._clearPendingSessionTab(tab.id);
          this.tabs.closeTab(tab.id, () => this._showStartPage());
          this._scheduleSaveAppState();
        });
      }
      tabEl.addEventListener("click", () => {
        if (this._tabSortInProgress) return;
        this.tabs.activateTab(tab.id);
      });
      tabEl.addEventListener("auxclick", (e) => {
        if (e.button === 1 && tab.closable) {
          e.preventDefault();
          if (tab.sessionId) {
            this.activeSessionIds.delete(tab.sessionId);
            if (this.focusedSessionId === tab.sessionId) this.focusedSessionId = null;
          }
          this._clearPendingSessionTab(tab.id);
          this.tabs.closeTab(tab.id, () => this._showStartPage());
          this._scheduleSaveAppState();
        }
      });
      this.tabList.appendChild(tabEl);
    }
    refreshIcons();

    // SortableJS for drag-to-reorder
    const self = this;
    this._sortable = Sortable.create(this.tabList, {
      animation: 150,
      draggable: ".tab-item",
      handle: ".tab-drag-handle",
      filter: ".tab-close",
      preventOnFilter: false,
      forceFallback: true,
      fallbackOnBody: true,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      fallbackTolerance: 6,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragClass: "sortable-drag",
      onStart() {
        self._tabSortInProgress = true;
        document.body.classList.add("tab-sorting");
      },
      onEnd(evt) {
        console.log("[Shelf] sortable onEnd tabId:", evt.item.dataset.tabId, "oldIndex:", evt.oldIndex, "newIndex:", evt.newIndex);
        const nextOrder = Array.from(self.tabList.querySelectorAll<HTMLElement>(".tab-item"))
          .map((el) => el.dataset.tabId)
          .filter((id): id is string => !!id);
        self.tabs.reorderToMatch(nextOrder);
        document.body.classList.remove("tab-sorting");
        setTimeout(() => { self._tabSortInProgress = false; }, 0);
        self._scheduleSaveAppState();
      },
    });
  }
}

new App().init();
