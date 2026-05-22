import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { escapeHtml, tauriInvoke } from "../helpers";
import { t } from "../i18n";
import { clearFileCache, renderFileTree } from "./files";
import { createTerminalTab, writeToPty } from "./terminal";
import { showTerminalMenu } from "./pickers";
import {
  PENDING_SESSION_DISCOVERY_TIMEOUT_MS,
  PENDING_SESSION_POLL_INTERVAL_MS,
  PENDING_SESSION_STABILIZE_MS,
  START_TAB_ID,
} from "./app-constants";
import type { FileEntry, Session, SessionProvider, TabInfo, WorkspaceItem } from "../types";

type PendingSessionTab = {
  workspacePath: string;
  provider: SessionProvider;
  baselineIds: Set<string>;
  startedAt: number;
  linkedSessionId?: string;
  stableUntil?: number;
  timer?: ReturnType<typeof setTimeout>;
};

type PendingSessionTabLike = PendingSessionTab & { linkedSessionId?: string };

export function _onTabAdd(app: any) {
  showTerminalMenu(app.tabAddBtn, (cwd) => app._createBlankTab(cwd), app.selectedWorkspace);
}

export async function _renameSessionPrompt(app: any, session: Session) {
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
      for (const ws of app.ws.workspaces) await app._refreshWorkspaceSessions(ws.path, ws.provider, "rename");
    } catch (e) { console.error("Rename failed:", e); }
    close();
  };
  panel.querySelector("#rename-save")!.addEventListener("click", doSave);
  panel.querySelector("#rename-cancel")!.addEventListener("click", close);
}

export async function _deleteSession(app: any, session: Session, wsPath: string) {
  try {
    await tauriInvoke("delete_session", { sessionId: session.id, provider: session.provider });
    app.activeSessionIds.delete(session.id);
    if (app.focusedSessionId === session.id) app.focusedSessionId = null;
    for (const [id, tab] of app.tabs.tabsMap) {
      if (tab.sessionId === session.id && tab.sessionProvider === session.provider) app.tabs.closeTab(id);
    }
    await app._refreshWorkspaceSessions(wsPath, session.provider, "delete");
    app._showToast(t("toast.deleted"));
    app._scheduleSaveAppState();
  } catch (e) { console.error("Delete failed:", e); }
}

export function _showToast(app: any, msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2500);
}

export async function _togglePin(app: any, session: Session) {
  try {
    if (app.pinnedIds.has(session.id)) {
      await tauriInvoke("unpin_session", { sessionId: session.id });
      app.pinnedIds.delete(session.id);
    } else {
      await tauriInvoke("pin_session", { sessionId: session.id });
      app.pinnedIds.add(session.id);
    }
    app._renderWorkspaces();
  } catch (e) { console.error("Pin toggle failed:", e); }
}

export async function _newClaudeSession(app: any, wsPath: string) {
  const tabId = crypto.randomUUID();
  const baselineIds = await app._sessionBaselineIds(wsPath, "claude");
  const tab = createTerminalTab(tabId, t("tab.claude_new"), app.terminalContainer,
    (id, data) => app._writePty(id, data),
    { cwd: wsPath, workspacePath: wsPath, sessionProvider: "claude", command: { bin: app.claudePath, args: [] } },
  );
  app.tabs.addTab(tab);
  app.pendingSessionTabs.set(tabId, {
    workspacePath: wsPath,
    provider: "claude",
    baselineIds,
    startedAt: Date.now(),
  });
  app._schedulePendingSessionPoll(tabId);
  app._scheduleSaveAppState();
}

export async function _newCodexSession(app: any, wsPath: string) {
  const tabId = crypto.randomUUID();
  const baselineIds = await app._sessionBaselineIds(wsPath, "codex");
  const tab = createTerminalTab(tabId, t("tab.codex_new"), app.terminalContainer,
    (id, data) => app._writePty(id, data),
    { cwd: wsPath, workspacePath: wsPath, sessionProvider: "codex", command: { bin: app.codexPath, args: ["-C", wsPath] } },
  );
  app.tabs.addTab(tab);
  app.pendingSessionTabs.set(tabId, {
    workspacePath: wsPath,
    provider: "codex",
    baselineIds,
    startedAt: Date.now(),
  });
  app._schedulePendingSessionPoll(tabId);
  app._scheduleSaveAppState();
}

export async function _sessionBaselineIds(app: any, wsPath: string, provider: SessionProvider): Promise<Set<string>> {
  let baselineSessions = app.ws.getSessions(wsPath, provider);
  try {
    const result = await app._refreshWorkspaceSessions(wsPath, provider, "new-session");
    baselineSessions = result.sessions;
  } catch (_) {
    /* keep existing cache as best-effort baseline */
  }
  return new Set(baselineSessions.map((session: Session) => session.id));
}

export function _schedulePendingSessionPoll(app: any, tabId: string) {
  const pending = app.pendingSessionTabs.get(tabId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    app._pollPendingSessionTab(tabId).catch((error: unknown) => {
      console.warn("[Shelf] pending session poll failed:", error);
      if (app._pendingSessionPollExpired(tabId)) {
        app._clearPendingSessionTab(tabId);
        return;
      }
      app._schedulePendingSessionPoll(tabId);
    });
  }, PENDING_SESSION_POLL_INTERVAL_MS);
}

export function _pendingSessionPollExpired(app: any, tabId: string): boolean {
  const pending = app.pendingSessionTabs.get(tabId);
  if (!pending) return true;
  const tab = app.tabs.tabsMap.get(tabId);
  const now = Date.now();
  if (pending.linkedSessionId) return !!pending.stableUntil && now >= pending.stableUntil;
  if (tab && !tab.ptyExited) return false;
  return now - pending.startedAt > PENDING_SESSION_DISCOVERY_TIMEOUT_MS;
}

export async function _pollPendingSessionTab(app: any, tabId: string) {
  const pending = app.pendingSessionTabs.get(tabId);
  const tab = app.tabs.tabsMap.get(tabId);
  if (!pending || !tab) {
    app._clearPendingSessionTab(tabId);
    return;
  }

  const { sessions } = await app._refreshWorkspaceSessions(pending.workspacePath, pending.provider, "new-session");
  const now = Date.now();

  if (!pending.linkedSessionId) {
    const session = app._findSessionForPendingSession(pending, sessions);
    if (session) {
      app._linkPendingSessionTab(tabId, pending, session);
    }
  } else {
    const session = sessions.find((item: Session) => item.id === pending.linkedSessionId);
    if (session && tab.title !== app._displayTitleForSession(session)) {
      tab.title = app._displayTitleForSession(session);
      pending.stableUntil = Date.now() + PENDING_SESSION_STABILIZE_MS;
      app._renderTabs();
    }
  }

  const latest = app.pendingSessionTabs.get(tabId);
  if (!latest) return;
  if (!latest.linkedSessionId && app._pendingSessionPollExpired(tabId)) {
    app._clearPendingSessionTab(tabId);
    return;
  }
  if (latest.linkedSessionId && latest.stableUntil && now >= latest.stableUntil) {
    app._clearPendingSessionTab(tabId);
    return;
  }
  app._schedulePendingSessionPoll(tabId);
}

export function _findSessionForPendingSession(app: any, pending: PendingSessionTab, sessions: Session[]): Session | undefined {
  const claimedSessionIds = new Set(
    Array.from(app.pendingSessionTabs.values() as Iterable<PendingSessionTabLike>)
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

export function _linkPendingSessionTab(app: any, tabId: string, pending: PendingSessionTab, session: Session) {
  const tab = app.tabs.tabsMap.get(tabId);
  if (!tab) {
    app._clearPendingSessionTab(tabId);
    return;
  }

  pending.linkedSessionId = session.id;
  pending.stableUntil = Date.now() + PENDING_SESSION_STABILIZE_MS;
  tab.sessionId = session.id;
  tab.title = app._displayTitleForSession(session);
  app.activeSessionIds.add(session.id);
  if (app.tabs.activeId === tabId) app.focusedSessionId = session.id;
  app.selectedWorkspace = pending.workspacePath;
  app.ws.selectedWorkspace = pending.workspacePath;
  app.ws.selectedProvider = pending.provider;
  app.ws.expandedProviders.add(pending.provider);
  app.ws.expandedWorkspaces.add(app.ws.workspaceKey(pending.workspacePath, pending.provider));
  app._renderTabs();
  app._renderWorkspaces();
  app._scheduleSaveAppState();
}

export function _clearPendingSessionTab(app: any, tabId: string) {
  const pending = app.pendingSessionTabs.get(tabId);
  if (pending?.timer) clearTimeout(pending.timer);
  app.pendingSessionTabs.delete(tabId);
}

export async function _refreshAllSessions(app: any) {
  app.refreshBtn.classList.add("spinning");
  try {
    for (const ws of app.ws.workspaces as WorkspaceItem[]) {
      await app._refreshWorkspaceSessions(ws.path, ws.provider, "manual");
    }
  } finally {
    app.refreshBtn.classList.remove("spinning");
  }
}

export function _createBlankTab(app: any, cwd?: string) {
  const tabId = crypto.randomUUID();
  let wsPath: string | undefined;
  let provider: SessionProvider | undefined;
  if (cwd) {
    const matches = (app.ws.workspaces as WorkspaceItem[])
      .filter((w: WorkspaceItem) => cwd === w.path || cwd.startsWith(w.path + "/"))
      .sort((a: WorkspaceItem, b: WorkspaceItem) => {
        if (a.provider === app.ws.selectedProvider && b.provider !== app.ws.selectedProvider) return -1;
        if (b.provider === app.ws.selectedProvider && a.provider !== app.ws.selectedProvider) return 1;
        return b.path.length - a.path.length;
      });
    const match = matches[0];
    wsPath = match?.path;
    provider = match?.provider;
  }
  const tab = createTerminalTab(tabId, t("tab.terminal"), app.terminalContainer,
    (id, data) => app._writePty(id, data),
    { cwd, workspacePath: wsPath, sessionProvider: provider, shell: app.shellSetting },
  );
  app.tabs.addTab(tab);
  app._scheduleSaveAppState();
}

export function _openSessionTab(app: any, session: Session, wsPath: string) {
  console.log(`[Shelf] openSessionTab id=${session.id} title="${session.display_title}" tabs=${app.tabs.tabsMap.size}`);
  for (const [, tab] of app.tabs.tabsMap) {
    if (tab.sessionId === session.id && tab.sessionProvider === session.provider) {
      app.tabs.activateTab(tab.id);
      app._scheduleSaveAppState();
      return;
    }
  }
  const tabId = crypto.randomUUID();
  const cwd = session.cwd || wsPath;
  const command = session.provider === "codex"
    ? { bin: app.codexPath, args: ["resume", session.id, "-C", cwd] }
    : { bin: app.claudePath, args: ["--resume", session.id] };
  const tab = createTerminalTab(tabId, app._displayTitleForSession(session), app.terminalContainer,
    (id, data) => app._writePty(id, data),
    { sessionId: session.id, sessionProvider: session.provider, cwd, workspacePath: wsPath, command },
  );
  app.tabs.addTab(tab);
  app.activeSessionIds.add(session.id);
  app.focusedSessionId = session.id;
  app._scheduleSaveAppState();
}

export function _writePty(app: any, tabId: string, data: string) {
  const tab = app.tabs.tabsMap.get(tabId);
  if (tab?.sessionId && app.pendingSessionTabs.has(tabId)) {
    const pending = app.pendingSessionTabs.get(tabId);
    if (pending) pending.stableUntil = Date.now() + PENDING_SESSION_STABILIZE_MS;
  }
  if (tab) writeToPty(tab, data);
}

export function _onActivateTab(app: any, tab: TabInfo) {
  app.focusedSessionId = tab.sessionId || null;
  app._syncActiveSessionIds();
  if (tab.workspacePath) {
    app.selectedWorkspace = tab.workspacePath;
    app.ws.selectedWorkspace = tab.workspacePath;
    app.ws.selectedProvider = tab.sessionProvider || null;
    if (tab.sessionProvider) {
      app.ws.expandedProviders.add(tab.sessionProvider);
      app.ws.expandedWorkspaces.add(app.ws.workspaceKey(tab.workspacePath, tab.sessionProvider));
    }
    app._loadFileTree(tab.workspacePath);
  }
  app._scheduleSaveAppState();
}

export function _onTerminalDrop(app: any, path: string) {
  const tab = app.tabs.getActiveTab();
  if (tab && tab.id !== START_TAB_ID && tab.pty) {
    app._clearPendingSessionTab(tab.id);
    writeToPty(tab, `'${path.replace(/'/g, "'\\''")}' `);
  }
}

export function _onWorkspaceSelected(app: any, newPath: string) {
  app.selectedWorkspace = newPath;
  app._loadFileTree(newPath);
  const activeTab = app.tabs.getActiveTab();
  if (!activeTab || activeTab.workspacePath !== newPath) {
    app._showStartPage();
    app.selectedWorkspace = newPath;
    app.ws.selectedWorkspace = newPath;
  }
  app._scheduleSaveAppState();
}

export async function _loadFileTree(app: any, path: string) {
  try {
    const files = await tauriInvoke<FileEntry[]>("list_files", { path });
    app.expandedDirs.clear();
    app.loadedDirs.clear();
    clearFileCache();
    await renderFileTree(app.fileTreeEl, files, app.expandedDirs, app.loadedDirs, app.selectedWorkspace || "", () => app._loadFileTree(app.selectedWorkspace!));
  } catch (e) {
    console.error("List files:", e);
    app.fileTreeEl.innerHTML = `<div class="tree-empty">${t("file.failed")}</div>`;
  }
}

export function _refreshCurrentFileTree(app: any) {
  const path = app.selectedWorkspace || app.tabs.getActiveTab()?.workspacePath;
  if (!path) return;
  clearFileCache();
  app._loadFileTree(path);
}
