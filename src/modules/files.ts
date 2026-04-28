import { FileEntry } from "../types";
import { refreshIcons } from "../helpers";

export function renderFileTree(
  container: HTMLElement,
  files: FileEntry[],
  expandedDirs: Set<string>,
  lastFileTree: FileEntry[],
  indent = 0,
): void {
  if (indent === 0) {
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

    if (file.is_dir) {
      const isExpanded = expandedDirs.has(file.path);
      const hasChildren = file.children.length > 0;
      if (hasChildren) {
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
    item.style.cursor = "grab";
    item.appendChild(name);

    if (file.is_dir && file.children.length > 0) {
      item.style.cursor = "pointer";
      item.addEventListener("click", () => {
        if (expandedDirs.has(file.path)) {
          expandedDirs.delete(file.path);
        } else {
          expandedDirs.add(file.path);
        }
        renderFileTree(container, lastFileTree, expandedDirs, lastFileTree, 0);
      });
    }

    container.appendChild(item);

    if (file.is_dir && expandedDirs.has(file.path)) {
      renderFileTree(container, file.children, expandedDirs, lastFileTree, indent + 1);
    }
  }

  if (indent === 0) refreshIcons();
}
