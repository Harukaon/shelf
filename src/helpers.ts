import { createIcons, Folder, FolderOpen, File, ChevronRight, Plus, X, Circle, CircleDot, Disc, Trash2, Pin, MessageSquare, Search, Minus, Square, Bot, Wrench, Loader, Clock, CornerUpLeft, Server } from "lucide";

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> } };
  }
}

export const ICONS = { Folder, FolderOpen, File, ChevronRight, Plus, X, Circle, CircleDot, Disc, Trash2, Pin, MessageSquare, Search, Minus, Square, Bot, Wrench, Loader, Clock, CornerUpLeft, Server };

export function refreshIcons() {
  createIcons({ icons: ICONS, attrs: { stroke: "currentColor", width: "14", height: "14", "stroke-width": "1.5" } });
}

export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return Promise.reject(new Error("Tauri not available"));
  return tauri.core.invoke(cmd, args) as Promise<T>;
}

export function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function formatDate(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
