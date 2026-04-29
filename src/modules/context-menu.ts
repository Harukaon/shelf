import { tauriInvoke } from "../helpers";

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

let currentMenu: HTMLElement | null = null;

function closeMenu() {
  if (currentMenu) { currentMenu.remove(); currentMenu = null; }
}

document.addEventListener("click", closeMenu);

export function showContextMenu(items: MenuItem[], x: number, y: number) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:1001;`;

  for (const item of items) {
    const el = document.createElement("div");
    el.className = `context-item${item.disabled ? " disabled" : ""}`;
    el.textContent = item.label;
    if (!item.disabled) {
      el.addEventListener("click", () => { closeMenu(); item.action(); });
    }
    menu.appendChild(el);
  }

  // Adjust position if menu goes off screen
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;

  currentMenu = menu;
}
