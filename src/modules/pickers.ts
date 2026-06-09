import { Session } from "../types";
import { refreshIcons, escapeHtml, formatDate } from "../helpers";
import { t } from "../i18n";

export function showTerminalMenu(
  addBtn: HTMLElement,
  createBlankTab: (cwd?: string) => void,
  selectedWorkspace: string | null,
) {
  createBlankTab(selectedWorkspace || undefined);
}

export function showSessionPicker(
  allSessions: { session: Session; workspacePath: string }[],
  onSelect: (session: Session, wsPath: string) => void,
  displayTitleForSession: (session: Session) => string = (session) => session.display_title,
) {
  if (allSessions.length === 0) return;

  const picker = document.createElement("div");
  picker.className = "session-picker";
  picker.innerHTML = `<div class="picker-search"><i data-lucide="search"></i><input placeholder="${t("picker.search")}" autofocus></div><div class="picker-list"></div>`;
  document.body.appendChild(picker);
  refreshIcons();

  const input = picker.querySelector("input")!;
  const list = picker.querySelector(".picker-list")!;

  const renderFiltered = (filter: string) => {
    list.innerHTML = "";
    const filtered = allSessions.filter(({ session }) =>
      displayTitleForSession(session).toLowerCase().includes(filter.toLowerCase()),
    );
    if (filtered.length === 0) {
      list.innerHTML = `<div class="picker-empty">${t("picker.empty")}</div>`;
      return;
    }
    for (const { session, workspacePath } of filtered.slice(0, 20)) {
      const title = displayTitleForSession(session);
      const item = document.createElement("div");
      item.className = "picker-item";
      item.innerHTML = `<i data-lucide="message-square"></i><span class="picker-title">${escapeHtml(title)}</span><span class="picker-date">${formatDate(session.started_at)}</span>`;
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
