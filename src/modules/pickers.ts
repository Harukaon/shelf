import { Session } from "../types";
import { refreshIcons, escapeHtml, formatDate } from "../helpers";

export function showTerminalMenu(
  addBtn: HTMLElement,
  createBlankTab: (cwd?: string) => void,
  createSessionTab: (session: Session, wsPath: string) => void,
  sessionsGetter: () => { session: Session; workspacePath: string }[],
  selectedWorkspace: string | null,
) {
  const menu = document.createElement("div");
  menu.className = "picker-menu";
  menu.innerHTML = `
    <div class="picker-menu-item" data-action="blank">
      <i data-lucide="plus"></i><span>New Blank Terminal</span>
    </div>
    <div class="picker-menu-item" data-action="session">
      <i data-lucide="message-square"></i><span>Open Session...</span>
    </div>`;

  const rect = addBtn.getBoundingClientRect();
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;min-width:180px;z-index:1001;`;

  document.body.appendChild(menu);
  refreshIcons();

  const backdrop = document.createElement("div");
  backdrop.className = "picker-backdrop";
  const close = () => { menu.remove(); backdrop.remove(); };

  menu.querySelector("[data-action='blank']")!.addEventListener("click", () => {
    close();
    createBlankTab(selectedWorkspace || undefined);
  });
  menu.querySelector("[data-action='session']")!.addEventListener("click", () => {
    close();
    showSessionPicker(sessionsGetter(), createSessionTab);
  });
  backdrop.addEventListener("click", close);
  document.body.appendChild(backdrop);
}

export function showSessionPicker(
  allSessions: { session: Session; workspacePath: string }[],
  onSelect: (session: Session, wsPath: string) => void,
) {
  if (allSessions.length === 0) return;

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
      session.display_title.toLowerCase().includes(filter.toLowerCase()),
    );
    if (filtered.length === 0) {
      list.innerHTML = '<div class="picker-empty">No sessions found</div>';
      return;
    }
    for (const { session, workspacePath } of filtered.slice(0, 20)) {
      const item = document.createElement("div");
      item.className = "picker-item";
      item.innerHTML = `<i data-lucide="message-square"></i><span class="picker-title">${escapeHtml(session.display_title)}</span><span class="picker-date">${formatDate(session.started_at)}</span>`;
      item.addEventListener("click", () => { closeAll(); onSelect(session, workspacePath); });
      list.appendChild(item);
    }
    refreshIcons();
  };

  const backdrop = document.createElement("div");
  backdrop.className = "picker-backdrop";
  const closeAll = () => { picker.remove(); backdrop.remove(); };
  backdrop.addEventListener("click", closeAll);
  document.body.appendChild(backdrop);

  renderFiltered("");
  input.addEventListener("input", () => renderFiltered(input.value));
  input.focus();
}
