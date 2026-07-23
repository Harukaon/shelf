import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { tauriInvoke } from "../helpers";
import { t } from "../i18n";
import { START_TAB_ID } from "./app-constants";
import { createTerminalTab, scheduleTerminalRefit } from "./terminal";
import { buildSshArgs } from "./ssh";
import { buildLocalCliCommand, buildRemoteCliCommand } from "./cli-launch";
import type { SessionProvider, SshTarget, TabInfo } from "../types";

export type SavedWindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
};

export type SavedTabState = {
  id: string;
  kind: "terminal" | "session" | "new-session";
  title: string;
  cwd?: string;
  workspacePath?: string;
  sessionProvider?: SessionProvider;
  sessionId?: string;
  shell?: string;
  ssh?: SshTarget;
};

export type SavedAppState = {
  version: 1;
  activeTabId?: string;
  selectedWorkspace?: string | null;
  selectedProvider?: SessionProvider | null;
  window?: SavedWindowState;
  tabs: SavedTabState[];
};

export async function _loadSavedAppState(app: any) {
  try {
    const state = await tauriInvoke<Partial<SavedAppState>>("get_app_state");
    if (state?.version === 1 && Array.isArray(state.tabs)) {
      app.restoredState = state as SavedAppState;
    }
  } catch (e) {
    console.warn("[Shelf] app state not available:", e);
  }
}

export async function _restoreWindowState(app: any) {
  const state = app.restoredState?.window;
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

export function _buildAppState(app: any, windowState?: SavedWindowState): SavedAppState {
  const tabs: SavedTabState[] = [];
  for (const tabId of app.tabs.getTabOrder()) {
    const tab = app.tabs.tabsMap.get(tabId);
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
      ssh: (tab as any).ssh,
    });
  }

  return {
    version: 1,
    activeTabId: app.tabs.activeId || undefined,
    selectedWorkspace: app.selectedWorkspace,
    selectedProvider: app.ws.selectedProvider,
    window: windowState,
    tabs,
  };
}

export async function _readWindowState(_app: any): Promise<SavedWindowState | undefined> {
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

export async function _saveAppStateNow(app: any) {
  if (!app.appStateReady || app.restoreInProgress) return;
  const state = app._buildAppState(await app._readWindowState() || app.restoredState?.window);
  try {
    await tauriInvoke("save_app_state", { state });
    app.restoredState = state;
  } catch (e) {
    console.warn("[Shelf] save app state failed:", e);
  }
}

export function _scheduleSaveAppState(app: any, delay = 300) {
  if (!app.appStateReady || app.restoreInProgress) return;
  if (app.saveStateTimer) clearTimeout(app.saveStateTimer);
  app.saveStateTimer = setTimeout(() => {
    app.saveStateTimer = null;
    app._saveAppStateNow();
  }, delay);
}

export function _setupWindowStateTracking(app: any) {
  const win = getCurrentWebviewWindow();
  win.onMoved(() => app._scheduleSaveAppState()).catch((e) => console.warn("[Shelf] window move tracking failed:", e));
  win.onResized(() => {
    const tab = app.tabs.getActiveTab();
    if (tab) scheduleTerminalRefit(tab);
    app._scheduleSaveAppState();
  }).catch((e) => console.warn("[Shelf] window resize tracking failed:", e));
}

export async function _restoreSavedTabs(app: any) {
  const state = app.restoredState;
  if (!state || state.tabs.length === 0) {
    app._scheduleSaveAppState();
    return;
  }

  app.restoreInProgress = true;
  try {
    for (const saved of state.tabs) {
      if (app.tabs.tabsMap.has(saved.id) || saved.id === START_TAB_ID) continue;
      const tab = app._createRestoredTab(saved);
      if (tab) app.tabs.addTab(tab, false);
    }

    if (app.tabs.getTabOrder().some((id: string) => id !== START_TAB_ID)) {
      const start = app.tabs.tabsMap.get(START_TAB_ID);
      if (start) {
        start.containerEl.style.visibility = "hidden";
        start.containerEl.style.pointerEvents = "none";
        start.active = false;
      }
    }

    const restoredTabIds = app.tabs.getTabOrder().filter((id: string) => id !== START_TAB_ID);
    const activeId = state.activeTabId && state.activeTabId !== START_TAB_ID && app.tabs.tabsMap.has(state.activeTabId)
      ? state.activeTabId
      : restoredTabIds[0];
    if (activeId) {
      app.tabs.activateTab(activeId);
    } else {
      app._showStartPage();
    }

    app.selectedWorkspace = state.selectedWorkspace || app.tabs.getActiveTab()?.workspacePath || null;
    app.ws.selectedWorkspace = app.selectedWorkspace;
    app.ws.selectedProvider = state.selectedProvider || app.tabs.getActiveTab()?.sessionProvider || null;
  } finally {
    app.restoreInProgress = false;
    app._syncActiveSessionIds();
    app._syncFocusedSessionId();
    app._clearUnreadState();
    app._renderTabs();
    app._renderWorkspaces();
    app._scheduleSaveAppState();
  }
}

export function _createRestoredTab(app: any, saved: SavedTabState): TabInfo | null {
  const unreadOptions = {
    onUnreadChange: (id: string, v: boolean) => app._onUnreadChange(id, v),
    suppressUnreadWhile: (id: string) => app.restoreInProgress === true || app._shouldSuppressRestoredTabUnread(id),
  };

  if (saved.kind === "session") {
    if (!saved.sessionId || !saved.sessionProvider || !saved.workspacePath) return null;
    const session = app.ws.getSessions(saved.workspacePath, saved.sessionProvider)
      .find((item: any) => item.id === saved.sessionId);
    if (!session) return null;
    const cwd = session.cwd || saved.cwd || saved.workspacePath;
    const extraArgs = app._cliArgsForProvider(session.provider);
    const bin = app._cliPathForProvider(session.provider);
    const command = buildLocalCliCommand(session.provider, bin, extraArgs, cwd, session.id);
    // If this was an SSH session, spawn via SSH
    if (saved.ssh) {
      const remoteCmd = buildRemoteCliCommand(session.provider, extraArgs, cwd, session.id);
      const sshArgs = buildSshArgs(saved.ssh, remoteCmd);
      const tab = createTerminalTab(saved.id, app._displayTitleForSession(session) || saved.title, app.terminalContainer,
        (id, data) => app._writePty(id, data),
        { sessionId: session.id, sessionProvider: session.provider, cwd, workspacePath: saved.workspacePath, command: { bin: "ssh", args: sshArgs }, ssh: saved.ssh, ...unreadOptions },
      );
      app._beginRestoredTabUnreadSuppression(tab.id);
      return tab;
    }
    const tab = createTerminalTab(saved.id, app._displayTitleForSession(session) || saved.title, app.terminalContainer,
      (id, data) => app._writePty(id, data),
      { sessionId: session.id, sessionProvider: session.provider, cwd, workspacePath: saved.workspacePath, command, ...unreadOptions },
    );
    app._beginRestoredTabUnreadSuppression(tab.id);
    return tab;
  }

  if (saved.kind === "new-session") {
    if (!saved.sessionProvider || !saved.workspacePath) return null;
    const extraArgs = app._cliArgsForProvider(saved.sessionProvider);
    // If this was an SSH session, spawn via SSH
    if (saved.ssh) {
      const remoteCmd = buildRemoteCliCommand(saved.sessionProvider, extraArgs, saved.workspacePath);
      const sshArgs = buildSshArgs(saved.ssh, remoteCmd);
      const title = saved.title || t("ssh.new_shell");
      const tab = createTerminalTab(saved.id, title, app.terminalContainer,
        (id, data) => app._writePty(id, data),
        { cwd: saved.workspacePath, workspacePath: saved.workspacePath, sessionProvider: saved.sessionProvider, command: { bin: "ssh", args: sshArgs }, ssh: saved.ssh, ...unreadOptions },
      );
      app._beginRestoredTabUnreadSuppression(tab.id);
      return tab;
    }
    const bin = app._cliPathForProvider(saved.sessionProvider);
    const command = buildLocalCliCommand(saved.sessionProvider, bin, extraArgs, saved.workspacePath);
    const title = saved.title || app._newSessionTitle(saved.sessionProvider);
    const tab = createTerminalTab(saved.id, title, app.terminalContainer,
      (id, data) => app._writePty(id, data),
      { cwd: saved.workspacePath, workspacePath: saved.workspacePath, sessionProvider: saved.sessionProvider, command, ...unreadOptions },
    );
    app._beginRestoredTabUnreadSuppression(tab.id);
    app.pendingSessionTabs.set(saved.id, {
      workspacePath: saved.workspacePath,
      provider: saved.sessionProvider,
      baselineIds: new Set(app.ws.getSessions(saved.workspacePath, saved.sessionProvider).map((session: any) => session.id)),
      startedAt: Date.now(),
    });
    app._schedulePendingSessionPoll(saved.id);
    return tab;
  }

  // SSH plain shell tab
  if (saved.ssh) {
    const sshArgs = buildSshArgs(saved.ssh);
    const tab = createTerminalTab(saved.id, saved.title || t("ssh.new_shell"), app.terminalContainer,
      (id, data) => app._writePty(id, data),
      { cwd: saved.cwd, workspacePath: saved.workspacePath, sessionProvider: saved.sessionProvider, shell: "ssh", command: { bin: "ssh", args: sshArgs }, ssh: saved.ssh, ...unreadOptions },
    );
    app._beginRestoredTabUnreadSuppression(tab.id);
    return tab;
  }

  const tab = createTerminalTab(saved.id, saved.title || t("tab.terminal"), app.terminalContainer,
    (id, data) => app._writePty(id, data),
    {
      cwd: saved.cwd,
      workspacePath: saved.workspacePath,
      sessionProvider: saved.sessionProvider,
      shell: saved.shell || app.shellSetting,
      ...unreadOptions,
    },
  );
  app._beginRestoredTabUnreadSuppression(tab.id);
  return tab;
}
