import "@xterm/xterm/css/xterm.css";
import { installFileLoggerBridge } from "./modules/logger";
installFileLoggerBridge();
import { tauriInvoke, refreshIcons } from "./helpers";
import { Session, TabInfo, SessionProvider, SshTarget, AiSessionMap, AiHistoryMessage, AiGroup, ShellCommandApproval } from "./types";
import { TabManager } from "./modules/tabs";
import { WorkspaceManager } from "./modules/workspace";
import { applyTerminalTheme, scheduleTerminalRefit, setTerminalThemeMode, createTerminalTab, type TerminalThemeMode } from "./modules/terminal";
import { setupFileTreeContextMenu } from "./modules/files";
import { setupDragDrop, setupPanelResize } from "./modules/dragdrop";
import { t, setLang, getLang } from "./i18n";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import Sortable from "sortablejs";
import { showContextMenu } from "./modules/context-menu";
import { openDialog } from "./modules/dialog";
import { showToast } from "./modules/toast";
import { buildSshArgs } from "./modules/ssh";
import { buildRemoteCliCommand } from "./modules/cli-launch";
import { scheduleUpdateCheck } from "./modules/update-check";
import { APP_THEMES, SESSION_POLL_INTERVAL_MS, START_TAB_ID, THEME_STORAGE_KEY, type AppTheme } from "./modules/app-constants";
import * as settingsPanel from "./modules/settings-panel";
import * as aiWindow from "./modules/ai-window";
import * as sessionActions from "./modules/session-actions";
import * as workspaceView from "./modules/workspace-view";
import * as appState from "./modules/app-state";
import type { AiToolMessage } from "./modules/ai-window";
import type { SavedAppState, SavedTabState, SavedWindowState } from "./modules/app-state";

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

class App {
  tabs!: TabManager;
  ws!: WorkspaceManager;
  activeSessionIds = new Set<string>();
  focusedSessionId: string | null = null;
  shellSetting = "zsh";
  theme: AppTheme = "dark";
  claudePath = "claude";
  codexPath = "codex";
  claudeArgs: string[] = [];
  codexArgs: string[] = [];
  pinnedIds = new Set<string>();
  sessionTitleOverrides = new Map<string, string>();
  pendingSessionTabs = new Map<string, PendingSessionTab>();
  sessionScanSeq = new Map<string, number>();
  restoredState: SavedAppState | null = null;
  restoreInProgress = false;
  restoredUnreadMutedTabs = new Set<string>();
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
    this._clearUnreadState();

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
        { label: "SSH", action: () => this._promptAddSshWorkspace() },
      ], rect.left, rect.top);
      e.stopPropagation();
    });
    setupFileTreeContextMenu(this.fileTreeEl, () => this._refreshCurrentFileTree());

    this._setupPlatformWindowControls();

    setupDragDrop(
      this.terminalContainer,
      this.workspaceList,
      (path) => this._onTerminalDrop(path),
      (path) => this.ws.add(path, "claude").catch((e) => {
        console.error("Add workspace failed:", e);
        showToast(t("toast.workspace_add_failed", String(e)), { variant: "error" });
      }),
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
    for (const ws of this.ws.workspaces) { await this._refreshWorkspaceSessions(ws.path, ws.provider, "init", ws.ssh); }
    await this._restoreSavedTabs();
    this._renderWorkspaces();
    this._setupWindowStateTracking();
    this.appStateReady = true;
    this._scheduleSaveAppState();
    this._startPassivePolling();
    scheduleUpdateCheck();
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
    return this.sessionTitleOverrides.get(session.id) || session.display_title;
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

    const tab = {
      id: START_TAB_ID, title: t("tab.home"), closable: false,
      terminal: null,
      fitAddon: null,
      containerEl: container,
      active: shouldActivateStart,
    } as unknown as TabInfo;
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
      const claudeArgs = s?.claudeArgs || s?.claude_args;
      const codexArgs = s?.codexArgs || s?.codex_args;
      if (Array.isArray(claudeArgs)) {
        this.claudeArgs = claudeArgs.filter((arg: unknown): arg is string => typeof arg === "string");
      }
      if (Array.isArray(codexArgs)) {
        this.codexArgs = codexArgs.filter((arg: unknown): arg is string => typeof arg === "string");
      }
      if (s?.session_titles || s?.sessionTitles) {
        const titles = s.session_titles || s.sessionTitles;
        this.sessionTitleOverrides = new Map(
          Object.entries(titles as Record<string, string>)
            .map(([id, title]) => [id, String(title).trim()] as const)
            .filter(([, title]) => title.length > 0),
        );
      }
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
    if (document.querySelector(".dialog-quit")) return;

    const handle = openDialog({
      title: t("settings.quit_title"),
      description: t("settings.quit_note"),
      actions: [
        {
          label: t("settings.quit"),
          variant: "danger",
          isDefault: true,
          onClick: () => {
            if (this.saveStateTimer) {
              clearTimeout(this.saveStateTimer);
              this.saveStateTimer = null;
            }
            (async () => {
              await this._saveAppStateNow();
              await this.tabs.closeAllPtys();
              await tauriInvoke("exit_app");
            })().catch((e) => console.error("Quit failed:", e));
          },
        },
        { label: t("settings.cancel") },
      ],
    });
    handle.panel.classList.add("dialog-quit");
  }

  private _passiveTimer: ReturnType<typeof setInterval> | null = null;

  private _startPassivePolling() {
    if (this._passiveTimer) clearInterval(this._passiveTimer);
    this._passiveTimer = setInterval(() => {
      for (const ws of this.ws.workspaces) {
        this._refreshWorkspaceSessions(ws.path, ws.provider, "passive", ws.ssh).catch(() => {});
      }
    }, SESSION_POLL_INTERVAL_MS);
  }

  private async _refreshWorkspaceSessions(
    workspacePath: string,
    provider: SessionProvider,
    reason: "init" | "passive" | "manual" | "new-session" | "rename" | "delete",
    ssh?: SshTarget,
  ): Promise<{ sessions: Session[]; changed: boolean }> {
    const key = this.ws.workspaceKey(workspacePath, provider);
    const seq = (this.sessionScanSeq.get(key) || 0) + 1;
    this.sessionScanSeq.set(key, seq);
    const command = provider === "codex" ? "scan_codex_sessions" : "scan_sessions";
    let scanError: unknown = null;
    const sessions = await tauriInvoke<Session[]>(command, { workspacePath, ssh: ssh || null }).catch((e) => {
      console.error(`Scan ${provider} sessions:`, e);
      scanError = e;
      return [];
    });
    this._applySessionTitleOverridesToSessions(sessions);
    if (this.sessionScanSeq.get(key) !== seq) {
      return { sessions: this.ws.sessions.get(key) || [], changed: false };
    }
    if (scanError && (reason === "manual" || reason === "new-session")) {
      showToast(`${t("toast.scan_failed")}: ${String(scanError)}`, { variant: "error" });
    }
    const changed = this._applySessionSnapshot(workspacePath, provider, sessions, reason);
    return { sessions, changed };
  }

  private _applySessionTitleOverridesToSessions(sessions: Session[]) {
    for (const session of sessions) {
      const title = this.sessionTitleOverrides.get(session.id);
      if (title) session.display_title = title;
    }
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
      this._displayTitleForSession(session),
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

  private async _loadSavedAppState() { return appState._loadSavedAppState(this); }

  private async _restoreWindowState() { return appState._restoreWindowState(this); }

  private _buildAppState(windowState?: SavedWindowState): SavedAppState { return appState._buildAppState(this, windowState); }

  private async _readWindowState(): Promise<SavedWindowState | undefined> { return appState._readWindowState(this); }

  private async _saveAppStateNow() { return appState._saveAppStateNow(this); }

  private _scheduleSaveAppState(delay = 300) { return appState._scheduleSaveAppState(this, delay); }

  private _setupWindowStateTracking() { return appState._setupWindowStateTracking(this); }

  private async _restoreSavedTabs() { return appState._restoreSavedTabs(this); }

  private _createRestoredTab(saved: SavedTabState): TabInfo | null { return appState._createRestoredTab(this, saved); }

  private async _showSettings() { return settingsPanel._showSettings(this, APP_THEMES); }

  private async _loadAiModelsForSettings(panel: HTMLElement) { return settingsPanel._loadAiModelsForSettings(this, panel); }

  private _renderAiModelList(list: HTMLElement, modelInput: HTMLInputElement, models: string[]) { return settingsPanel._renderAiModelList(this, list, modelInput, models); }
  private _toggleAiWindow() { return aiWindow._toggleAiWindow(this); }

  private _createAiWindow() { return aiWindow._createAiWindow(this); }

  private _setupAiWindowDragging(panel: HTMLElement) { return aiWindow._setupAiWindowDragging(this, panel); }

  private async _sendAiMessage() { return aiWindow._sendAiMessage(this); }

  private async _stopAiRun() { return aiWindow._stopAiRun(this); }

  private async _runAiTurn(message: string, history: AiHistoryMessage[], rollbackUserOnError = false) { return aiWindow._runAiTurn(this, message, history, rollbackUserOnError); }

  private _isShellApprovalInterrupt(error: unknown): boolean { return aiWindow._isShellApprovalInterrupt(this, error); }

  private _isAiCancelled(error: unknown): boolean { return aiWindow._isAiCancelled(this, error); }

  private _setAiSending(sending: boolean) { return aiWindow._setAiSending(this, sending); }

  private _appendAiMessage(role: "user" | "assistant" | "system", text: string): HTMLElement { return aiWindow._appendAiMessage(this, role, text); }

  private async _listenToAiStream() { return aiWindow._listenToAiStream(this); }

  private _stopAiStreamListener() { return aiWindow._stopAiStreamListener(this); }

  private _appendAiTextDelta(text: string) { return aiWindow._appendAiTextDelta(this, text); }

  private _syncStreamingAssistantHistory(content: string) { return aiWindow._syncStreamingAssistantHistory(this, content); }

  private _ensureStreamingAssistantMessage(): HTMLElement { return aiWindow._ensureStreamingAssistantMessage(this); }

  private _ensureAiTextEl(target: HTMLElement): HTMLElement { return aiWindow._ensureAiTextEl(this, target); }

  private _clearAiHistory() { return aiWindow._clearAiHistory(this); }

  private _appendAiToolCall(id: string, tool: string, args: string) { return aiWindow._appendAiToolCall(this, id, tool, args); }

  private _finishAiToolCall(id: string, tool: string, result: string) { return aiWindow._finishAiToolCall(this, id, tool, result); }

  private _setAiToolResult(id: string, result: string) { return aiWindow._setAiToolResult(this, id, result); }

  private _recordAiToolHistory(tool: string, content: string) { return aiWindow._recordAiToolHistory(this, tool, content); }

  private _showShellApproval(id: string, tool: string, value: string) { return aiWindow._showShellApproval(this, id, tool, value); }

  private _parseShellApproval(value: string): ShellCommandApproval | null { return aiWindow._parseShellApproval(this, value); }

  private async _approveShellCommand(toolMessage: AiToolMessage) { return aiWindow._approveShellCommand(this, toolMessage); }

  private _denyShellCommand(toolMessage: AiToolMessage) { return aiWindow._denyShellCommand(this, toolMessage); }

  private async _continueAfterToolResult() { return aiWindow._continueAfterToolResult(this); }

  private _getOrCreateToolMessage(id: string, tool: string): AiToolMessage { return aiWindow._getOrCreateToolMessage(this, id, tool); }

  private _formatJsonLike(value: string): string { return aiWindow._formatJsonLike(this, value); }
  private _onTabAdd() { return sessionActions._onTabAdd(this); }

  private async _renameSessionPrompt(session: Session) { return sessionActions._renameSessionPrompt(this, session); }

  private async _deleteSession(session: Session, wsPath: string) { return sessionActions._deleteSession(this, session, wsPath); }

  private _showToast(msg: string) { return sessionActions._showToast(this, msg); }

  private async _togglePin(session: Session) { return sessionActions._togglePin(this, session); }

  private async _newClaudeSession(wsPath: string) { return sessionActions._newClaudeSession(this, wsPath); }

  private async _newCodexSession(wsPath: string) { return sessionActions._newCodexSession(this, wsPath); }

  private async _sessionBaselineIds(wsPath: string, provider: SessionProvider): Promise<Set<string>> { return sessionActions._sessionBaselineIds(this, wsPath, provider); }

  private _schedulePendingSessionPoll(tabId: string) { return sessionActions._schedulePendingSessionPoll(this, tabId); }

  private _pendingSessionPollExpired(tabId: string): boolean { return sessionActions._pendingSessionPollExpired(this, tabId); }

  private async _pollPendingSessionTab(tabId: string) { return sessionActions._pollPendingSessionTab(this, tabId); }

  private _findSessionForPendingSession(pending: PendingSessionTab, sessions: Session[]): Session | undefined { return sessionActions._findSessionForPendingSession(this, pending, sessions); }

  private _linkPendingSessionTab(tabId: string, pending: PendingSessionTab, session: Session) { return sessionActions._linkPendingSessionTab(this, tabId, pending, session); }

  private _clearPendingSessionTab(tabId: string) { return sessionActions._clearPendingSessionTab(this, tabId); }

  private async _refreshAllSessions() { return sessionActions._refreshAllSessions(this); }

  private _createBlankTab(cwd?: string) { return sessionActions._createBlankTab(this, cwd); }

  private _openSessionTab(session: Session, wsPath: string) { return sessionActions._openSessionTab(this, session, wsPath); }

  private _writePty(tabId: string, data: string) { return sessionActions._writePty(this, tabId, data); }

  private _onUnreadChange(_tabId: string, _hasUnread: boolean) {
    this._updateBadge();
    this._renderTabs();
  }

  private _clearUnreadState() {
    this.tabs?.tabsMap.forEach((tab) => {
      tab.hasUnreadOutput = false;
    });
    this._updateBadge();
    this._renderTabs();
  }

  private _beginRestoredTabUnreadSuppression(tabId: string) {
    this.restoredUnreadMutedTabs.add(tabId);
    const tab = this.tabs?.tabsMap.get(tabId);
    if (tab) tab.hasUnreadOutput = false;
  }

  private _shouldSuppressRestoredTabUnread(tabId: string): boolean {
    return this.restoredUnreadMutedTabs.has(tabId);
  }

  private _endRestoredTabUnreadSuppression(tabId: string, refresh = true) {
    if (!this.restoredUnreadMutedTabs.delete(tabId)) return;

    const tab = this.tabs?.tabsMap.get(tabId);
    if (tab?.hasUnreadOutput) tab.hasUnreadOutput = false;
    if (refresh) {
      this._updateBadge();
      this._renderTabs();
    }
  }

  private async _updateBadge() {
    let count = 0;
    this.tabs.tabsMap.forEach((tab) => {
      if (tab.hasUnreadOutput && tab.id !== START_TAB_ID) count++;
    });
    try {
      await getCurrentWebviewWindow().setBadgeCount(count > 0 ? count : undefined);
    } catch {
      /* unsupported on some platforms */
    }
  }

  private _onActivateTab(tab: TabInfo) {
    this._endRestoredTabUnreadSuppression(tab.id);
    return sessionActions._onActivateTab(this, tab);
  }

  private _onTerminalDrop(path: string) { return sessionActions._onTerminalDrop(this, path); }

  private _onWorkspaceSelected(newPath: string) { return sessionActions._onWorkspaceSelected(this, newPath); }

  private async _loadFileTree(path: string) { return sessionActions._loadFileTree(this, path); }

  private _refreshCurrentFileTree() { return sessionActions._refreshCurrentFileTree(this); }
  private _renderWorkspaces() { return workspaceView._renderWorkspaces(this); }

  private _renderAiOrganizerGroup(): HTMLElement { return workspaceView._renderAiOrganizerGroup(this); }

  private _aiCategories(): AiGroup[] { return workspaceView._aiCategories(this); }

  private _aiMappingEntries(categoryId?: string): Array<{ sessionKey: string; session: Session; workspacePath: string }> { return workspaceView._aiMappingEntries(this, categoryId); }

  private _renderAiCategoryItem(category: AiGroup, entries: Array<{ sessionKey: string; session: Session; workspacePath: string }>): HTMLElement { return workspaceView._renderAiCategoryItem(this, category, entries); }

  private _renderAiMappedSessionItem(sessionKey: string, session: Session, wsPath: string): HTMLElement { return workspaceView._renderAiMappedSessionItem(this, sessionKey, session, wsPath); }

  private _renameAiCategoryPrompt(category: AiGroup) { return workspaceView._renameAiCategoryPrompt(this, category); }

  private async _deleteAiCategory(categoryId: string) { return workspaceView._deleteAiCategory(this, categoryId); }

  private async _removeAiMapping(sessionKey: string) { return workspaceView._removeAiMapping(this, sessionKey); }

  private _renderProviderGroup(provider: SessionProvider, title: string): HTMLElement { return workspaceView._renderProviderGroup(this, provider, title); }

  private _promptAddSshWorkspace() { return workspaceView._promptAddSshWorkspace(this); }

  private _newSshClaudeSession(ws: import("./types").WorkspaceItem) {
    const tabId = crypto.randomUUID();
    const ssh = ws.ssh!;
    const sshArgs = buildSshArgs(ssh, buildRemoteCliCommand("claude", this.claudeArgs, ws.path));
    const tab = createTerminalTab(tabId, t("tab.claude_new"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd: ws.path, workspacePath: ws.path, sessionProvider: "claude", command: { bin: "ssh", args: sshArgs }, ssh, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
    );
    tab.sessionProvider = "claude";
    this.tabs.addTab(tab);
    this._scheduleSaveAppState();
  }

  private _newSshCodexSession(ws: import("./types").WorkspaceItem) {
    const tabId = crypto.randomUUID();
    const ssh = ws.ssh!;
    const sshArgs = buildSshArgs(ssh, buildRemoteCliCommand("codex", this.codexArgs, ws.path));
    const tab = createTerminalTab(tabId, t("tab.codex_new"), this.terminalContainer,
      (id, data) => this._writePty(id, data),
      { cwd: ws.path, workspacePath: ws.path, sessionProvider: "codex", command: { bin: "ssh", args: sshArgs }, ssh, onUnreadChange: (id, v) => this._onUnreadChange(id, v) },
    );
    tab.sessionProvider = "codex";
    this.tabs.addTab(tab);
    this._scheduleSaveAppState();
  }

  private _renderWorkspaceItem(ws: import("./types").WorkspaceItem): HTMLElement { return workspaceView._renderWorkspaceItem(this, ws); }

  private _toggleWorkspaceExpansion(wsPath: string, provider: SessionProvider, ssh?: SshTarget) { return workspaceView._toggleWorkspaceExpansion(this, wsPath, provider, ssh); }

  private _renderSessionItem(session: Session, wsPath: string, showProviderBadge = false): HTMLElement { return workspaceView._renderSessionItem(this, session, wsPath, showProviderBadge); }

  private _sortable: Sortable | null = null;
  private _tabSortInProgress = false;

  private _renderTabs() { return workspaceView._renderTabs(this); }
}

new App().init();
