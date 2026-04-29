import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";

type DropZone = "terminal" | "workspace";

function elementAtPhysicalPosition(position: { x: number; y: number }): Element | null {
  const scale = window.devicePixelRatio || 1;
  return document.elementFromPoint(position.x / scale, position.y / scale);
}

function isInTerminal(el: Element | null, terminalContainer: HTMLElement): boolean {
  return !!el && (
    terminalContainer.contains(el) ||
    !!el.closest(".terminal-wrapper") ||
    !!el.closest(".xterm") ||
    !!el.closest(".xterm-screen")
  );
}

function isInWorkspaceList(el: Element | null, workspaceListEl: HTMLElement): boolean {
  return !!el && workspaceListEl.contains(el);
}

function getDropZone(
  el: Element | null,
  terminalContainer: HTMLElement,
  workspaceListEl: HTMLElement,
): DropZone | null {
  if (isInTerminal(el, terminalContainer)) return "terminal";
  if (isInWorkspaceList(el, workspaceListEl)) return "workspace";
  return null;
}

function clearDropHighlights(terminalContainer: HTMLElement, workspaceListEl: HTMLElement) {
  terminalContainer.classList.remove("drag-target");
  workspaceListEl.classList.remove("drag-over");
}

export function setupDragDrop(
  terminalContainer: HTMLElement,
  workspaceListEl: HTMLElement,
  onTerminalDrop: (path: string) => void,
  onWorkspaceDrop: (path: string) => void,
) {
  let lastDrop: { zone: DropZone; path: string; at: number } | null = null;

  function dispatchDrop(zone: DropZone | null, path: string | undefined) {
    if (!zone || !path) return;

    const now = Date.now();
    if (lastDrop && lastDrop.zone === zone && lastDrop.path === path && now - lastDrop.at < 500) {
      return;
    }
    lastDrop = { zone, path, at: now };

    if (zone === "terminal") {
      onTerminalDrop(path);
    } else {
      onWorkspaceDrop(path);
    }
  }

  function updateDropHighlight(zone: DropZone | null) {
    terminalContainer.classList.toggle("drag-target", zone === "terminal");
    workspaceListEl.classList.toggle("drag-over", zone === "workspace");
  }

  // === Mouse-based drag from file tree → terminal ===
  let dragPath: string | null = null;
  let dragOverlay: HTMLElement | null = null;

  document.addEventListener("mousedown", (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const fileItem = target.closest("[data-path]") as HTMLElement | null;
    if (!fileItem) return;
    const path = fileItem.dataset.path;
    if (!path || e.button !== 0) return;
    e.preventDefault();
    dragPath = path;
    document.body.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragPath) return;
    if (!dragOverlay) {
      dragOverlay = document.createElement("div");
      dragOverlay.className = "drag-floating-label";
      dragOverlay.textContent = "\u{1F4C4} " + (dragPath.split("/").pop() || dragPath);
      document.body.appendChild(dragOverlay);
    }
    // Center label on cursor
    dragOverlay.style.left = `${e.clientX - dragOverlay.offsetWidth / 2}px`;
    dragOverlay.style.top = `${e.clientY - dragOverlay.offsetHeight / 2}px`;

    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    const inTerm = isInTerminal(elUnder, terminalContainer);
    terminalContainer.classList.toggle("drag-target", inTerm);
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    const path = dragPath;
    dragPath = null;
    terminalContainer.classList.remove("drag-target");
    document.body.style.cursor = "";
    if (dragOverlay) { dragOverlay.remove(); dragOverlay = null; }
    if (!path) return;

    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    if (isInTerminal(elUnder, terminalContainer)) onTerminalDrop(path);
  });

  // === Finder/native file drag ===
  // Tauri delivers absolute filesystem paths through webview drag-drop events.
  // Browser DataTransfer is kept below only as a fallback for text/file drops.
  try {
    getCurrentWebview().onDragDropEvent((event) => {
      const payload: DragDropEvent = event.payload;

      if (payload.type === "leave") {
        clearDropHighlights(terminalContainer, workspaceListEl);
        return;
      }

      const zone = getDropZone(
        elementAtPhysicalPosition(payload.position),
        terminalContainer,
        workspaceListEl,
      );

      if (payload.type === "enter" || payload.type === "over") {
        updateDropHighlight(zone);
        return;
      }

      clearDropHighlights(terminalContainer, workspaceListEl);
      dispatchDrop(zone, payload.paths[0]);
    }).catch((error) => {
      console.warn("[DragDrop] Native file drop unavailable:", error);
    });
  } catch (error) {
    console.warn("[DragDrop] Native file drop unavailable:", error);
  }

  // === HTML5 drop fallback → terminal ===
  // Use capture phase to intercept before xterm.js
  terminalContainer.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    terminalContainer.classList.add("drag-target");
  }, true);
  terminalContainer.addEventListener("dragleave", (e: DragEvent) => {
    // Only remove if truly left
    const rel = e.relatedTarget as Node | null;
    if (!rel || !terminalContainer.contains(rel)) {
      terminalContainer.classList.remove("drag-target");
    }
  }, true);
  terminalContainer.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    terminalContainer.classList.remove("drag-target");
    // Some environments expose a non-standard absolute path here, but Tauri's
    // native drag-drop event is the primary source for Finder paths.
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0] as unknown as { path?: string };
      if (file?.path) {
        dispatchDrop("terminal", file.path);
        return;
      }
    }
    // Handle custom text data (from HTML5 draggable elsewhere)
    const textPath = e.dataTransfer?.getData("text/plain");
    dispatchDrop("terminal", textPath);
  }, true);

  // Workspace panel: HTML5 fallback to add workspace
  workspaceListEl.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    workspaceListEl.classList.add("drag-over");
  });
  workspaceListEl.addEventListener("dragleave", () => workspaceListEl.classList.remove("drag-over"));
  workspaceListEl.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    workspaceListEl.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (files?.[0]) {
      const file = files[0] as unknown as { path?: string };
      dispatchDrop("workspace", file?.path);
    }
  });
}

// Panel resize: drag handles between panels
export function setupPanelResize(
  leftHandle: HTMLElement,
  rightHandle: HTMLElement,
  root: HTMLElement,
) {
  let dragging: HTMLElement | null = null;
  let startX = 0;
  let startWidth = 0;

  [leftHandle, rightHandle].forEach((h) => {
    h.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      dragging = h;
      startX = e.clientX;
      const prop = h === leftHandle ? "--left-panel-width" : "--right-panel-width";
      const style = getComputedStyle(root);
      startWidth = parseInt(style.getPropertyValue(prop));
      h.classList.add("active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    const diff = e.clientX - startX;
    const prop = dragging === leftHandle ? "--left-panel-width" : "--right-panel-width";
    const newWidth = Math.max(160, startWidth + (dragging === leftHandle ? diff : -diff));
    root.style.setProperty(prop, `${newWidth}px`);
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging.classList.remove("active");
      dragging = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Trigger terminal resize
      window.dispatchEvent(new Event("resize"));
    }
  });
}
