import { FileEntry } from "../types";
import { tauriInvoke, refreshIcons } from "../helpers";
import { showContextMenu } from "./context-menu";
import { t, getLang } from "../i18n";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

function showToast(msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2500);
}

const childCache = new Map<string, FileEntry[]>();

export function clearFileCache() {
  childCache.clear();
}

async function loadChildren(dirPath: string): Promise<FileEntry[]> {
  if (childCache.has(dirPath)) return childCache.get(dirPath)!;
  try {
    const children = await tauriInvoke<FileEntry[]>("list_files", { path: dirPath });
    childCache.set(dirPath, children);
    return children;
  } catch (e) {
    console.error("Load children failed:", e);
    return [];
  }
}

let selectedWorkspacePath = "";
let onRefreshTree: (() => void) | undefined;
let rootFiles: FileEntry[] = [];

export async function renderFileTree(
  container: HTMLElement,
  files: FileEntry[],
  expandedDirs: Set<string>,
  loadedDirs: Set<string>,
  wsPath: string,
  onRefresh?: () => void,
  indent = 0,
): Promise<void> {
  if (indent === 0) {
    selectedWorkspacePath = wsPath;
    onRefreshTree = onRefresh;
    rootFiles = files;
    container.innerHTML = "";
  }
  if (files.length === 0 && indent === 0) {
    container.innerHTML = '<div class="tree-empty">Empty directory</div>';
    return;
  }

  for (const file of files) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.style.paddingLeft = `${12 + indent * 16}px`;
    const isExpanded = expandedDirs.has(file.path);

    if (file.is_dir) {
      if (file.children.length > 0 || loadedDirs.has(file.path)) {
        item.innerHTML = `<i data-lucide="chevron-right" class="tree-arrow${isExpanded ? " expanded" : ""}"></i>`;
      } else {
        item.innerHTML = '<span class="tree-arrow-spacer"></span>';
      }
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", isExpanded ? "folder-open" : "folder");
      icon.className = "tree-icon";
      item.appendChild(icon);
    } else {
      item.innerHTML = '<span class="tree-arrow-spacer"></span>';
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", "file");
      icon.className = "tree-icon";
      item.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = file.name;
    item.dataset.path = file.path;
    item.style.cursor = file.is_dir ? "pointer" : "grab";
    item.appendChild(name);

    // Right-click context menu
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const absPath = file.path;
      const relPath = selectedWorkspacePath ? absPath.replace(selectedWorkspacePath + "/", "") : absPath;
      const isMac = navigator.platform.toLowerCase().includes("mac");
      showContextMenu([
        { label: isMac ? t("context.reveal") : t("context.reveal_win"), action: async () => {
          try { await revealItemInDir(absPath); } catch (_) {}
        }},
        { label: t("context.open"), action: async () => {
          try { await shellOpen(absPath); } catch (_) {}
        }},
        { label: t("context.copy_rel"), action: () => { navigator.clipboard.writeText(relPath); }},
        { label: t("context.copy_abs"), action: () => { navigator.clipboard.writeText(absPath); }},
        { label: t("context.delete"), action: async () => {
          try {
            await tauriInvoke("delete_file", { path: absPath });
            if (onRefreshTree) onRefreshTree();
            showToast(t("toast.deleted"));
          } catch (_) {}
        }},
      ], e.clientX, e.clientY);
    });

    if (file.is_dir) {
      item.addEventListener("click", async () => {
        if (expandedDirs.has(file.path)) {
          expandedDirs.delete(file.path);
        } else {
          if (!loadedDirs.has(file.path)) {
            file.children = await loadChildren(file.path);
            loadedDirs.add(file.path);
          }
          expandedDirs.add(file.path);
        }
        // Always re-render from root
        await renderFileTree(container, rootFiles, expandedDirs, loadedDirs, wsPath, onRefresh, 0);
      });
    }

    container.appendChild(item);

    if (file.is_dir && isExpanded && file.children.length > 0) {
      await renderFileTree(container, file.children, expandedDirs, loadedDirs, wsPath, onRefresh, indent + 1);
    }
  }

  if (indent === 0) refreshIcons();
}
