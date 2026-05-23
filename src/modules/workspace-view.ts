import Sortable from "sortablejs";
import { escapeHtml, formatDate, refreshIcons, tauriInvoke } from "../helpers";
import { t } from "../i18n";
import { showContextMenu } from "./context-menu";
import { openDialog, confirmDialog } from "./dialog";
import { SESSION_PAGE_SIZE } from "./app-constants";
import type { AiGroup, AiSessionMeta, Session, SessionProvider, SshTarget, WorkspaceItem } from "../types";

export function _renderWorkspaces(app: any) {
  app.workspaceList.innerHTML = "";

  if (app.pinnedIds.size > 0) {
    const pinnedDiv = document.createElement("div");
    pinnedDiv.className = "pinned-section";
    pinnedDiv.innerHTML = `<div class="pinned-label"><i data-lucide="pin"></i> ${t("workspace.pinned")}</div>`;
    for (const ws of app.ws.workspaces) {
      const sessions = app.ws.getSessions(ws.path, ws.provider);
      for (const session of sessions) {
        if (!app.pinnedIds.has(session.id)) continue;
        const item = app._renderSessionItem(session, ws.path, true);
        item.classList.add("pinned-item");
        pinnedDiv.appendChild(item);
      }
    }
    app.workspaceList.appendChild(pinnedDiv);
  }

  app.workspaceList.appendChild(app._renderAiOrganizerGroup());
  app.workspaceList.appendChild(app._renderProviderGroup("claude", "Claude Code"));
  app.workspaceList.appendChild(app._renderProviderGroup("codex", "Codex"));
  refreshIcons();
}

export function _renderAiOrganizerGroup(app: any): HTMLElement {
  const group = document.createElement("div");
  group.className = "provider-section provider-root ai-organizer-root";
  const categories = app._aiCategories();
  const mappingCount = app._aiMappingEntries().length;

  const header = document.createElement("div");
  header.className = "provider-header provider-root-header ai-organizer-header";
  header.innerHTML = `
    <i data-lucide="chevron-right" class="provider-arrow${app.expandedAiOrganizer ? " expanded" : ""}"></i>
    <span class="provider-title">${escapeHtml(t("ai.organizer_section"))}</span>
    <span class="provider-count">${mappingCount}</span>`;
  header.addEventListener("click", () => {
    app.expandedAiOrganizer = !app.expandedAiOrganizer;
    app._renderWorkspaces();
  });
  group.appendChild(header);

  if (!app.expandedAiOrganizer) return group;

  if (categories.length === 0 || mappingCount === 0) return group;

  for (const category of categories) {
    const entries = app._aiMappingEntries(category.id);
    if (entries.length === 0) continue;
    group.appendChild(app._renderAiCategoryItem(category, entries));
  }

  return group;
}

export function _aiCategories(app: any): AiGroup[] {
  const groups = Object.values(app.aiSessionMap.groups as Record<string, AiGroup>);
  return groups
    .filter((group) => app._aiMappingEntries(group.id).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function _aiMappingEntries(app: any, categoryId?: string): Array<{ sessionKey: string; session: Session; workspacePath: string }> {
  const entries: Array<{ sessionKey: string; session: Session; workspacePath: string }> = [];
  for (const [sessionKey, meta] of Object.entries(app.aiSessionMap.sessions as Record<string, AiSessionMeta>)) {
    if (!meta?.groupId) continue;
    if (categoryId && meta.groupId !== categoryId) continue;
    const resolved = app._findSessionByKey(sessionKey);
    if (!resolved) continue;
    entries.push({ sessionKey, ...resolved });
  }
  return entries.sort((a, b) => b.session.updated_at.localeCompare(a.session.updated_at));
}

export function _renderAiCategoryItem(app: any, 
  category: AiGroup,
  entries: Array<{ sessionKey: string; session: Session; workspacePath: string }>,
): HTMLElement {
  const categoryEl = document.createElement("div");
  categoryEl.className = "ai-category-item";
  const isExpanded = !app.collapsedAiCategories.has(category.id);

  const header = document.createElement("div");
  header.className = "workspace-header ai-category-header";
  header.innerHTML = `
    <i data-lucide="chevron-right" class="ws-arrow${isExpanded ? " expanded" : ""}"></i>
    <i data-lucide="${isExpanded ? "folder-open" : "folder"}"></i>
    <span class="ai-category-name" title="${escapeHtml(category.description || category.name)}">${escapeHtml(category.name)}</span>
    <span class="provider-count">${entries.length}</span>`;
  header.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isExpanded) app.collapsedAiCategories.add(category.id);
    else app.collapsedAiCategories.delete(category.id);
    app._renderWorkspaces();
  });
  header.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu([
      { label: t("context.rename"), action: () => app._renameAiCategoryPrompt(category) },
      { label: t("context.delete"), action: () => app._deleteAiCategory(category.id) },
    ], e.clientX, e.clientY);
  });
  categoryEl.appendChild(header);

  if (isExpanded) {
    const sessionList = document.createElement("div");
    sessionList.className = "workspace-sessions show ai-category-sessions";
    for (const entry of entries) {
      sessionList.appendChild(app._renderAiMappedSessionItem(entry.sessionKey, entry.session, entry.workspacePath));
    }
    categoryEl.appendChild(sessionList);
  }
  return categoryEl;
}

export function _renderAiMappedSessionItem(app: any, sessionKey: string, session: Session, wsPath: string): HTMLElement {
  const item = app._renderSessionItem(session, wsPath, true) as HTMLElement;
  item.classList.add("ai-mapped-session");
  item.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu([
      { label: t("context.rename"), action: () => app._renameSessionPrompt(session) },
      { label: t("ai.remove_mapping"), action: () => app._removeAiMapping(sessionKey) },
    ], e.clientX, e.clientY);
  });
  return item;
}

export function _renameAiCategoryPrompt(app: any, category: AiGroup) {
  const input = document.createElement("input");
  input.value = category.name;

  const row = document.createElement("div");
  row.className = "settings-row";
  row.appendChild(input);

  openDialog({
    title: t("ai.rename_category"),
    body: row,
    actions: [
      {
        label: t("settings.save"),
        variant: "primary",
        isDefault: true,
        onClick: async () => {
          const nextName = input.value.trim();
          if (!nextName) return false;
          const current = app.aiSessionMap.groups[category.id];
          if (!current) return;
          app.aiSessionMap.groups[category.id] = { ...current, name: nextName };
          await app._saveAiSessionMap();
          app._renderWorkspaces();
        },
      },
      { label: t("settings.cancel") },
    ],
  });
  input.focus();
  input.select();
}

export async function _deleteAiCategory(app: any, categoryId: string) {
  const category = app.aiSessionMap.groups[categoryId];
  const name = category?.name || categoryId;
  const confirmed = await confirmDialog({
    title: t("confirm.delete_category_title"),
    description: t("confirm.delete_category_message", name),
    confirmLabel: t("confirm.delete"),
    cancelLabel: t("settings.cancel"),
    danger: true,
  });
  if (!confirmed) return;
  delete app.aiSessionMap.groups[categoryId];
  app.collapsedAiCategories.delete(categoryId);
  for (const [sessionKey, meta] of Object.entries(app.aiSessionMap.sessions as Record<string, AiSessionMeta>)) {
    if (meta.groupId !== categoryId) continue;
    delete app.aiSessionMap.sessions[sessionKey];
  }
  await app._saveAiSessionMap();
  app._renderWorkspaces();
}

export async function _removeAiMapping(app: any, sessionKey: string) {
  delete app.aiSessionMap.sessions[sessionKey];
  await app._saveAiSessionMap();
  app._renderWorkspaces();
}

export function _renderProviderGroup(app: any, provider: SessionProvider, title: string): HTMLElement {
  const group = document.createElement("div");
  group.className = "provider-section provider-root";
  const workspaces = (app.ws.workspaces as WorkspaceItem[]).filter((workspace: WorkspaceItem) => workspace.provider === provider);
  const isExpanded = app.ws.expandedProviders.has(provider);

  const header = document.createElement("div");
  header.className = "provider-header provider-root-header";
  header.innerHTML = `
    <i data-lucide="chevron-right" class="provider-arrow${isExpanded ? " expanded" : ""}"></i>
    <span class="provider-title">${escapeHtml(title)}</span>
    <span class="provider-count">${workspaces.length}</span>
    <button class="provider-new-btn" title="${t("workspace.add")}">+</button>`;
  header.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (app.ws.expandedProviders.has(provider)) app.ws.expandedProviders.delete(provider);
    else app.ws.expandedProviders.add(provider);
    app._renderWorkspaces();
  });
  header.querySelector(".provider-new-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    app.ws.promptAdd(provider);
  });
  group.appendChild(header);

  if (isExpanded) {
    for (const ws of workspaces) {
      group.appendChild(app._renderWorkspaceItem(ws));
    }
  }
  return group;
}

export function _renderWorkspaceItem(app: any, ws: WorkspaceItem): HTMLElement {
  const wsDiv = document.createElement("div");
  wsDiv.className = "workspace-item provider-workspace-item";
  const key = app.ws.workspaceKey(ws.path, ws.provider);
  const isSelected = app.selectedWorkspace === ws.path && app.ws.selectedProvider === ws.provider;
  const isExpanded = app.ws.expandedWorkspaces.has(key);
  const sessions = app.ws.getSessions(ws.path, ws.provider);
  const page = app.ws.sessionPages.get(key) || 1;
  const pageEnd = page * SESSION_PAGE_SIZE;

  const header = document.createElement("div");
  header.className = `workspace-header${isSelected ? " selected" : ""}`;
  const sshTag = ws.ssh ? ` <span class="ssh-badge">${escapeHtml(t("ssh.badge"))}</span>` : "";
  const icon = ws.ssh ? "server" : (isExpanded ? "folder-open" : "folder");
  header.innerHTML = `
    <i data-lucide="chevron-right" class="ws-arrow${isExpanded ? " expanded" : ""}"></i>
    <i data-lucide="${icon}"></i>
    <span class="ws-name">${escapeHtml(ws.name)}${sshTag}</span>
    <span class="ws-actions">
      <button class="ws-new-btn" title="${t("workspace.new")}">+</button>
      <button class="ws-remove-btn" title="${t("workspace.remove")}"><i data-lucide="trash-2"></i></button>
    </span>`;
  header.querySelector(".ws-new-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    if (ws.ssh) {
      const task = ws.provider === "claude"
        ? app._newSshClaudeSession(ws)
        : app._newSshCodexSession(ws);
      task.catch((error: unknown) => console.error("New SSH session failed:", error));
    } else {
      const task = ws.provider === "claude"
        ? app._newClaudeSession(ws.path)
        : app._newCodexSession(ws.path);
      task.catch((error: unknown) => console.error("New session failed:", error));
    }
  });
  const removeBtn = header.querySelector(".ws-remove-btn") as HTMLButtonElement;
  let deletePending = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const resetRemoveBtn = () => {
    deletePending = false;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    removeBtn.classList.remove("pending");
    removeBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    removeBtn.removeAttribute("title");
    removeBtn.setAttribute("title", t("workspace.remove"));
    refreshIcons();
  };
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (deletePending) {
      const toClose: string[] = [];
      for (const [, tab] of app.tabs.tabsMap) {
        if (tab.workspacePath === ws.path && tab.sessionProvider === ws.provider && tab.closable) toClose.push(tab.id);
      }
      for (const id of toClose) {
        if (app.tabs.tabsMap.get(id)?.sessionId) {
          app.activeSessionIds.delete(app.tabs.tabsMap.get(id)!.sessionId!);
          app.focusedSessionId = null;
        }
        app._clearPendingSessionTab(id);
        app.tabs.closeTab(id);
      }
      resetRemoveBtn();
      app.ws.remove(ws.path, ws.provider, ws.ssh);
      app._showStartPage();
    } else {
      deletePending = true;
      removeBtn.classList.add("pending");
      removeBtn.textContent = t("confirm.delete");
      removeBtn.setAttribute("title", t("confirm.workspace_countdown", "3"));
      pendingTimer = setTimeout(resetRemoveBtn, 3000);
    }
  });
  removeBtn.addEventListener("mouseleave", () => {
    if (!deletePending) return;
    // give a small grace period; reset after 1.2s on mouse leave
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(resetRemoveBtn, 1200);
  });
  header.addEventListener("click", () => {
    app._toggleWorkspaceExpansion(ws.path, ws.provider, ws.ssh);
  });
  wsDiv.appendChild(header);

  if (isExpanded) {
    const sessionList = document.createElement("div");
    sessionList.className = "workspace-sessions show";
    if (sessions.length === 0 && !app.ws.sessions.has(key)) {
      const loading = document.createElement("div");
      loading.className = "workspace-loading";
      loading.innerHTML = `<i data-lucide="loader" class="spin"></i> ${t("session.loading")}`;
      sessionList.appendChild(loading);
    } else {
      for (const session of sessions.slice(0, pageEnd)) {
        sessionList.appendChild(app._renderSessionItem(session, ws.path));
      }
      if (pageEnd < sessions.length) {
        const remaining = sessions.length - pageEnd;
        const moreBtn = document.createElement("div");
        moreBtn.className = "session-load-more";
        moreBtn.textContent = `${t("session.load")} ${Math.min(remaining, SESSION_PAGE_SIZE)} ${t("session.load_more")} (${remaining} ${t("session.remaining")})`;
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          app.ws.sessionPages.set(key, page + 1);
          app._renderWorkspaces();
        });
        sessionList.appendChild(moreBtn);
      }
    }
    wsDiv.appendChild(sessionList);
  }
  return wsDiv;
}

export function _toggleWorkspaceExpansion(app: any, wsPath: string, provider: SessionProvider, ssh?: SshTarget) {
  const key = app.ws.workspaceKey(wsPath, provider);
  const shouldExpand = !app.ws.expandedWorkspaces.has(key);

  if (shouldExpand) {
    app.ws.expandedProviders.add(provider);
    app.ws.expandedWorkspaces.add(key);
    app._renderWorkspaces();
    if (!app.ws.sessions.has(key)) {
      app._refreshWorkspaceSessions(wsPath, provider, "manual", ssh)
        .catch((error: unknown) => console.error("Expand workspace scan failed:", error))
        .finally(() => app._renderWorkspaces());
    }
  } else {
    app.ws.expandedWorkspaces.delete(key);
    app._renderWorkspaces();
  }
}

export function _renderSessionItem(app: any, session: Session, wsPath: string, showProviderBadge = false): HTMLElement {
  const isActive = app.activeSessionIds.has(session.id);
  const isFocused = app.focusedSessionId === session.id;
  const item = document.createElement("div");
  const badge = session.provider === "codex" ? "CX" : "CC";
  const title = app._displayTitleForSession(session);
  item.className = `session-item${isActive ? " active" : ""}${isFocused ? " focused" : ""}`;
  item.innerHTML = `
    <span class="dot-icon${isFocused ? " focused" : ""}"></span>
    <span class="session-title" title="${escapeHtml(session.display_title)}">${escapeHtml(title)}</span>
    ${showProviderBadge ? `<span class="provider-badge ${session.provider}">${badge}</span>` : ""}
    <span class="session-date">${formatDate(session.started_at)}</span>`;
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    app._openSessionTab(session, wsPath);
    app._renderWorkspaces();
  });
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isPinned = app.pinnedIds.has(session.id);
    const items = [
      { label: t("context.rename"), action: () => app._renameSessionPrompt(session) },
      { label: isPinned ? t("context.unpin") : t("context.pin"), action: () => app._togglePin(session) },
      { label: t("context.delete"), action: () => app._deleteSession(session, wsPath) },
    ];
    showContextMenu(items, e.clientX, e.clientY);
  });
  return item;
}


export function _renderTabs(app: any) {
  app.tabList.innerHTML = "";
  if (app._sortable) { app._sortable.destroy(); app._sortable = null; }
  const order = app.tabs.getTabOrder();

  for (const tabId of order) {
    const tab = app.tabs.tabsMap.get(tabId)!;
    const tabEl = document.createElement("div");
    const isTabActive = tab.id === app.tabs.activeId;
    tabEl.className = `tab-item${isTabActive ? " active" : ""}${tab.closable ? " closable" : ""}`;
    tabEl.dataset.tabId = tab.id;
    const closeHtml = tab.closable ? `<span class="tab-close" title="${t("tab.close")}"><i data-lucide="x"></i></span>` : "";
    tabEl.innerHTML = `
      <span class="tab-drag-handle">
        <span class="dot-icon${isTabActive ? " active" : ""}"></span>
        <span class="tab-title">${escapeHtml(tab.title)}</span>
      </span>
      ${closeHtml}`;
    if (tab.closable) {
      tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        if (tab.sessionId) {
          app.activeSessionIds.delete(tab.sessionId);
          if (app.focusedSessionId === tab.sessionId) app.focusedSessionId = null;
        }
        app._clearPendingSessionTab(tab.id);
        app.tabs.closeTab(tab.id, () => app._showStartPage());
        app._scheduleSaveAppState();
      });
    }
    tabEl.addEventListener("click", () => {
      if (app._tabSortInProgress) return;
      app.tabs.activateTab(tab.id);
    });
    tabEl.addEventListener("auxclick", (e) => {
      if (e.button === 1 && tab.closable) {
        e.preventDefault();
        if (tab.sessionId) {
          app.activeSessionIds.delete(tab.sessionId);
          if (app.focusedSessionId === tab.sessionId) app.focusedSessionId = null;
        }
        app._clearPendingSessionTab(tab.id);
        app.tabs.closeTab(tab.id, () => app._showStartPage());
        app._scheduleSaveAppState();
      }
    });
    app.tabList.appendChild(tabEl);
  }
  refreshIcons();

  // SortableJS for drag-to-reorder
  const self = app;
  app._sortable = Sortable.create(app.tabList, {
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
      const nextOrder = Array.from((self.tabList as HTMLElement).querySelectorAll(".tab-item") as NodeListOf<HTMLElement>)
        .map((el: HTMLElement) => el.dataset.tabId)
        .filter((id): id is string => !!id);
        self.tabs.reorderToMatch(nextOrder);
        document.body.classList.remove("tab-sorting");
        setTimeout(() => { self._tabSortInProgress = false; }, 0);
        self._scheduleSaveAppState();
      },
    });
}

export async function _promptAddSshWorkspace(app: any): Promise<void> {
  const [configHosts, history] = await Promise.all([
    tauriInvoke<Array<{ alias: string; hostName: string | null; user: string | null; port: number | null; identityFile: string | null }>>("ssh_list_config_hosts").catch(() => []),
    tauriInvoke<Array<{ ssh: SshTarget; remotePath: string; lastConnected: string }>>("ssh_get_history").catch(() => []),
  ]);

  const panel = document.createElement("div");
  panel.className = "settings-panel";
  panel.style.maxWidth = "440px";

  const quickSelectHtml = configHosts.length === 0 ? "" : `
    <div class="ssh-quick-section">
      <div class="ssh-quick-label">${t("ssh.from_config")}</div>
      <div class="ssh-quick-list">
        ${configHosts.slice(0, 10).map((h) => {
          const userPart = h.user || "";
          const hostPart = h.hostName || h.alias;
          const title = userPart ? `${userPart}@${hostPart}` : hostPart;
          return `<div class="ssh-quick-item"
            data-alias="${escapeHtml(h.alias)}"
            data-user="${escapeHtml(userPart)}"
            data-hostname="${escapeHtml(hostPart)}"
            data-port="${h.port || 22}"
            data-key="${escapeHtml(h.identityFile || "")}"
            title="${escapeHtml(title)}">${escapeHtml(h.alias)}</div>`;
        }).join("")}
      </div>
    </div>`;

  const historyHtml = history.length === 0 ? "" : `
    <div class="ssh-quick-section">
      <div class="ssh-quick-label">${t("ssh.history")}</div>
      <div class="ssh-quick-list">
        ${history.slice(0, 5).map((h) => {
          const label = h.ssh.user ? `${h.ssh.user}@${h.ssh.host}` : h.ssh.host;
          const portSuffix = h.ssh.port && h.ssh.port !== 22 ? `:${h.ssh.port}` : "";
          return `<div class="ssh-history-item"
            data-user="${escapeHtml(h.ssh.user || "")}"
            data-host="${escapeHtml(h.ssh.host)}"
            data-port="${h.ssh.port || 22}"
            data-key="${escapeHtml(h.ssh.identityFile || "")}"
            data-path="${escapeHtml(h.remotePath)}"
            title="${escapeHtml(label + portSuffix)} → ${escapeHtml(h.remotePath)}">
            <i data-lucide="clock"></i>
            <span>${escapeHtml(label + portSuffix)}</span>
            <span class="ssh-history-path">${escapeHtml(h.remotePath)}</span>
          </div>`;
        }).join("")}
      </div>
    </div>`;

  panel.innerHTML = `
    <div class="settings-title">${t("ssh.add_title")}</div>
    ${quickSelectHtml}
    ${historyHtml}
    <div class="settings-section-title">${t("ssh.connection_info")}</div>
    <div class="settings-row">
      <label>${t("ssh.host")}</label>
      <input id="ssh-host" placeholder="${t("ssh.host_placeholder")}" autofocus>
    </div>
    <div class="settings-row">
      <label>${t("ssh.username")}</label>
      <input id="ssh-user" placeholder="root">
      <label style="margin-left:8px;">${t("ssh.port")}</label>
      <input id="ssh-port" type="number" value="22" min="1" max="65535" style="width:70px;flex:0 0 auto;">
    </div>
    <div class="settings-row">
      <label>${t("ssh.identity_file")}</label>
      <input id="ssh-key" placeholder="${t("ssh.identity_placeholder")}">
    </div>
    <div class="settings-row">
      <label>${t("ssh.password")}</label>
      <input id="ssh-password" type="password" placeholder="${t("ssh.password_placeholder")}">
    </div>
    <div class="settings-section-title">${t("ssh.workspace_info")}</div>
    <div class="settings-row">
      <label>${t("ssh.provider")}</label>
      <select id="ssh-provider">
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
      </select>
    </div>
    <div class="settings-row">
      <label>${t("ssh.remote_path")}</label>
      <div class="settings-inline-actions" style="flex:1;">
        <input id="ssh-remote-path" placeholder="${t("ssh.remote_path_placeholder")}">
        <button id="ssh-browse-btn" type="button">${t("ssh.browse")}</button>
      </div>
    </div>
    <div id="ssh-browse" class="ssh-browse">
      <div class="ssh-browse-header">
        <span class="ssh-browse-path" id="ssh-browse-path"></span>
        <button class="ssh-browse-select-btn" id="ssh-browse-select" type="button">${t("ssh.select_dir")}</button>
      </div>
      <div class="ssh-browse-list" id="ssh-browse-list"></div>
      <div class="ssh-browse-hint">${t("ssh.browse_hint")}</div>
    </div>
    <div id="ssh-status" class="dialog-status"></div>
    <div class="settings-actions">
      <button id="ssh-test-btn" type="button">${t("ssh.test")}</button>
      <button id="ssh-save-btn" type="button">${t("settings.save")}</button>
      <button id="ssh-cancel-btn" type="button">${t("settings.cancel")}</button>
    </div>`;

  const backdrop = document.createElement("div");
  backdrop.className = "picker-backdrop";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    panel.remove();
    backdrop.remove();
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKeydown);
  backdrop.addEventListener("click", close);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);

  const $ = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
  const userInput = $<HTMLInputElement>("#ssh-user");
  const hostInput = $<HTMLInputElement>("#ssh-host");
  const portInput = $<HTMLInputElement>("#ssh-port");
  const passwordInput = $<HTMLInputElement>("#ssh-password");
  const keyInput = $<HTMLInputElement>("#ssh-key");
  const providerInput = $<HTMLSelectElement>("#ssh-provider");
  const pathInput = $<HTMLInputElement>("#ssh-remote-path");
  const browseBtn = $<HTMLButtonElement>("#ssh-browse-btn");
  const browseEl = $<HTMLDivElement>("#ssh-browse");
  const browsePathEl = $<HTMLSpanElement>("#ssh-browse-path");
  const browseListEl = $<HTMLDivElement>("#ssh-browse-list");
  const browseSelectBtn = $<HTMLButtonElement>("#ssh-browse-select");
  const status = $<HTMLDivElement>("#ssh-status");
  const testBtn = $<HTMLButtonElement>("#ssh-test-btn");
  const saveBtn = $<HTMLButtonElement>("#ssh-save-btn");
  const cancelBtn = $<HTMLButtonElement>("#ssh-cancel-btn");

  const setStatus = (text: string, variant: "default" | "success" | "error" | "loading" = "default") => {
    status.className = "dialog-status" + (variant === "success" ? " success" : variant === "error" ? " error" : "");
    if (variant === "loading") {
      status.innerHTML = `<i data-lucide="loader" class="spin" style="width:12px;height:12px;"></i> ${escapeHtml(text)}`;
      refreshIcons();
    } else {
      status.textContent = text;
    }
  };
  const clearStatus = () => { status.className = "dialog-status"; status.textContent = ""; };

  const clearSelection = () => {
    panel.querySelectorAll(".ssh-quick-item.selected, .ssh-history-item.selected").forEach((el) => el.classList.remove("selected"));
  };

  panel.querySelectorAll(".ssh-quick-item").forEach((el) => {
    el.addEventListener("click", () => {
      const item = el as HTMLElement;
      clearSelection();
      item.classList.add("selected");
      userInput.value = item.dataset.user || "";
      hostInput.value = item.dataset.hostname || item.dataset.alias || "";
      portInput.value = item.dataset.port || "22";
      keyInput.value = item.dataset.key || "";
      clearStatus();
      pathInput.focus();
    });
  });

  panel.querySelectorAll(".ssh-history-item").forEach((el) => {
    el.addEventListener("click", () => {
      const item = el as HTMLElement;
      clearSelection();
      item.classList.add("selected");
      userInput.value = item.dataset.user || "";
      hostInput.value = item.dataset.host || "";
      portInput.value = item.dataset.port || "22";
      keyInput.value = item.dataset.key || "";
      pathInput.value = item.dataset.path || "~";
      clearStatus();
    });
  });

  refreshIcons();
  hostInput.focus();

  const getSshTarget = (): SshTarget => {
    const user = userInput.value.trim() || undefined;
    const host = hostInput.value.trim();
    const portRaw = portInput.value ? parseInt(portInput.value, 10) : NaN;
    const port = Number.isFinite(portRaw) && portRaw !== 22 ? portRaw : undefined;
    const password = passwordInput.value || undefined;
    const identityFile = keyInput.value.trim() || undefined;
    return { host, user, port, password, identityFile };
  };

  const requireHost = (): SshTarget | null => {
    const ssh = getSshTarget();
    if (!ssh.host) {
      setStatus(t("ssh.host_required"), "error");
      hostInput.focus();
      return null;
    }
    return ssh;
  };

  let currentBrowsePath = "";
  let browseSeq = 0;
  const loadRemoteDir = async (dirPath: string) => {
    const ssh = requireHost();
    if (!ssh) return;
    const seq = ++browseSeq;
    browseEl.classList.add("show");
    browsePathEl.textContent = dirPath;
    browseSelectBtn.disabled = true;
    browseBtn.disabled = true;
    browseListEl.innerHTML = `<div class="ssh-browse-state"><i data-lucide="loader" class="spin" style="width:12px;height:12px;"></i> ${escapeHtml(t("ssh.loading_dir"))}</div>`;
    refreshIcons();
    try {
      const entries = await tauriInvoke<Array<{ name: string; is_dir: boolean; path: string }>>(
        "list_files",
        { path: dirPath, ssh },
      );
      if (seq !== browseSeq) return;
      currentBrowsePath = dirPath;
      browsePathEl.textContent = dirPath;
      browseSelectBtn.disabled = false;
      browseListEl.innerHTML = "";

      if (dirPath !== "/" && dirPath !== "~") {
        const parent = dirPath.replace(/\/[^/]+\/?$/, "") || "/";
        const parentEl = document.createElement("div");
        parentEl.className = "ssh-browse-item parent";
        parentEl.innerHTML = `<i data-lucide="corner-up-left" style="width:12px;height:12px;"></i> <span>..</span>`;
        parentEl.title = parent;
        parentEl.addEventListener("click", () => loadRemoteDir(parent));
        browseListEl.appendChild(parentEl);
      }

      const sorted = (entries || []).slice().sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      let hasEntry = false;
      for (const entry of sorted) {
        hasEntry = true;
        const item = document.createElement("div");
        item.className = `ssh-browse-item ${entry.is_dir ? "dir" : "file"}`;
        const childPath = entry.path || `${dirPath.replace(/\/$/, "")}/${entry.name}`;
        item.title = childPath;
        const iconName = entry.is_dir ? "folder" : "file";
        item.innerHTML = `<i data-lucide="${iconName}" style="width:12px;height:12px;"></i> <span>${escapeHtml(entry.name)}</span>`;
        if (entry.is_dir) {
          item.addEventListener("click", () => loadRemoteDir(childPath));
        }
        browseListEl.appendChild(item);
      }

      if (!hasEntry && browseListEl.children.length === 0) {
        const emptyEl = document.createElement("div");
        emptyEl.className = "ssh-browse-state";
        emptyEl.textContent = t("ssh.empty_dir");
        browseListEl.appendChild(emptyEl);
      }
      refreshIcons();
    } catch (e) {
      if (seq !== browseSeq) return;
      browseSelectBtn.disabled = true;
      browseListEl.innerHTML = `<div class="ssh-browse-state error">${escapeHtml(t("ssh.browse_failed"))}: ${escapeHtml(String(e))}</div>`;
    } finally {
      if (seq === browseSeq) browseBtn.disabled = false;
    }
  };

  browseBtn.addEventListener("click", () => {
    const start = pathInput.value.trim() || "~";
    loadRemoteDir(start);
  });

  browseSelectBtn.addEventListener("click", () => {
    if (currentBrowsePath) {
      pathInput.value = currentBrowsePath;
      browseEl.classList.remove("show");
      pathInput.focus();
    }
  });

  testBtn.addEventListener("click", async () => {
    const ssh = requireHost();
    if (!ssh) return;
    testBtn.disabled = true;
    setStatus(t("ssh.testing"), "loading");
    try {
      const result = await tauriInvoke<string>("ssh_test_connection", { ssh });
      if (result === "OK") {
        setStatus(t("ssh.test_ok"), "success");
      } else {
        setStatus(t("ssh.test_fail"), "error");
      }
    } catch (e) {
      setStatus(`${t("ssh.test_fail")}: ${String(e)}`, "error");
    } finally {
      testBtn.disabled = false;
    }
  });

  let saving = false;
  const doSave = async () => {
    if (saving) return;
    const ssh = requireHost();
    if (!ssh) return;
    const remotePath = pathInput.value.trim() || "~";
    const provider = providerInput.value as SessionProvider;
    saving = true;
    saveBtn.disabled = true;
    testBtn.disabled = true;
    cancelBtn.disabled = true;
    setStatus(t("ssh.saving"), "loading");
    try {
      await app.ws.add(remotePath, provider, ssh);
      await tauriInvoke("ssh_add_history", { ssh, remotePath }).catch(() => {});
      close();
    } catch (e) {
      setStatus(`${t("ssh.save_failed")}: ${String(e)}`, "error");
      saving = false;
      saveBtn.disabled = false;
      testBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  };

  hostInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
  saveBtn.addEventListener("click", doSave);
  cancelBtn.addEventListener("click", close);
}
