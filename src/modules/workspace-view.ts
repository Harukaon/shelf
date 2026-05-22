import Sortable from "sortablejs";
import { escapeHtml, formatDate, refreshIcons } from "../helpers";
import { t } from "../i18n";
import { showContextMenu } from "./context-menu";
import { SESSION_PAGE_SIZE } from "./app-constants";
import type { AiGroup, AiSessionMeta, Session, SessionProvider, WorkspaceItem } from "../types";

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
    const current = app.aiSessionMap.groups[category.id];
    if (!current) return close();
    app.aiSessionMap.groups[category.id] = { ...current, name: nextName };
    await app._saveAiSessionMap();
    close();
    app._renderWorkspaces();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
  panel.querySelector("#rename-save")!.addEventListener("click", doSave);
  panel.querySelector("#rename-cancel")!.addEventListener("click", close);
}

export async function _deleteAiCategory(app: any, categoryId: string) {
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
      ? app._newClaudeSession(ws.path)
      : app._newCodexSession(ws.path);
    task.catch((error: unknown) => console.error("New session failed:", error));
  });
  const removeBtn = header.querySelector(".ws-remove-btn") as HTMLButtonElement;
  let deletePending = false;
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
      app.ws.remove(ws.path, ws.provider); app._showStartPage();
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
    app._toggleWorkspaceExpansion(ws.path, ws.provider);
  });
  wsDiv.appendChild(header);

  if (isExpanded) {
    const sessionList = document.createElement("div");
    sessionList.className = "workspace-sessions show";
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
    wsDiv.appendChild(sessionList);
  }
  return wsDiv;
}

export function _toggleWorkspaceExpansion(app: any, wsPath: string, provider: SessionProvider) {
  const key = app.ws.workspaceKey(wsPath, provider);
  const shouldExpand = !app.ws.expandedWorkspaces.has(key);

  if (shouldExpand) {
    app.ws.expandedProviders.add(provider);
    app.ws.expandedWorkspaces.add(key);
    if (!app.ws.sessions.has(key)) {
      app._refreshWorkspaceSessions(wsPath, provider, "manual")
        .catch((error: unknown) => console.error("Expand workspace scan failed:", error))
        .finally(() => app._renderWorkspaces());
    }
  } else {
    app.ws.expandedWorkspaces.delete(key);
  }

  app._renderWorkspaces();
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
