export function setupDragDrop(
  terminalContainer: HTMLElement,
  workspaceListEl: HTMLElement,
  onTerminalDrop: (path: string) => void,
  onWorkspaceDrop: (path: string) => void,
) {
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
    // Center label above cursor
    dragOverlay.style.left = `${e.clientX - dragOverlay.offsetWidth / 2}px`;
    dragOverlay.style.top = `${e.clientY - 28}px`;

    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    const inTerm = elUnder && (
      terminalContainer.contains(elUnder) ||
      !!elUnder.closest(".terminal-wrapper") ||
      !!elUnder.closest(".xterm") ||
      !!elUnder.closest(".xterm-screen")
    );
    terminalContainer.classList.toggle("drag-target", !!inTerm);
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    const path = dragPath;
    dragPath = null;
    terminalContainer.classList.remove("drag-target");
    document.body.style.cursor = "";
    if (dragOverlay) { dragOverlay.remove(); dragOverlay = null; }
    if (!path) return;

    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    const inTerm = elUnder && (
      terminalContainer.contains(elUnder) ||
      !!elUnder.closest(".terminal-wrapper") ||
      !!elUnder.closest(".xterm") ||
      !!elUnder.closest(".xterm-screen")
    );
    if (inTerm) onTerminalDrop(path);
  });

  // === Finder drag (native HTML5 drop) → terminal ===
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
    // Handle Finder files (native drop)
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0] as unknown as { path?: string };
      if (file?.path) {
        onTerminalDrop(file.path);
        return;
      }
    }
    // Handle custom text data (from HTML5 draggable elsewhere)
    const textPath = e.dataTransfer?.getData("text/plain");
    if (textPath) onTerminalDrop(textPath);
  }, true);

  // Workspace panel: Finder drop to add workspace
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
      if (file?.path) onWorkspaceDrop(file.path);
    }
  });
}
