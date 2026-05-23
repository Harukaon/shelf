import { escapeHtml, refreshIcons } from "../helpers";

export type DialogStatusVariant = "default" | "success" | "error" | "loading";

export interface DialogAction {
  id?: string;
  label: string;
  variant?: "primary" | "danger" | "default";
  /** Called when clicked. Return false to keep dialog open; throw to surface as error status. */
  onClick?: () => void | boolean | Promise<void | boolean>;
  /** Set true to trigger this action via Enter on the dialog. */
  isDefault?: boolean;
}

export interface DialogHandle {
  panel: HTMLElement;
  body: HTMLElement;
  close: () => void;
  setStatus: (text: string, variant?: DialogStatusVariant) => void;
  clearStatus: () => void;
  setActionsDisabled: (disabled: boolean) => void;
  triggerDefault: () => void;
}

export interface DialogOptions {
  title: string;
  body?: HTMLElement | string;
  description?: string;
  actions?: DialogAction[];
  maxWidth?: number;
  /** If true, ESC and backdrop click will not close the dialog. */
  persistent?: boolean;
  onClose?: () => void;
}

export function openDialog(opts: DialogOptions): DialogHandle {
  const panel = document.createElement("div");
  panel.className = "settings-panel";
  if (opts.maxWidth) panel.style.maxWidth = `${opts.maxWidth}px`;

  const title = document.createElement("div");
  title.className = "settings-title";
  title.textContent = opts.title;
  panel.appendChild(title);

  if (opts.description) {
    const desc = document.createElement("p");
    desc.className = "settings-note";
    desc.textContent = opts.description;
    panel.appendChild(desc);
  }

  const body = document.createElement("div");
  body.className = "dialog-body";
  if (typeof opts.body === "string") body.innerHTML = opts.body;
  else if (opts.body) body.appendChild(opts.body);
  panel.appendChild(body);

  const status = document.createElement("div");
  status.className = "dialog-status";
  panel.appendChild(status);

  const actionsEl = document.createElement("div");
  actionsEl.className = "settings-actions";
  panel.appendChild(actionsEl);

  const backdrop = document.createElement("div");
  backdrop.className = "picker-backdrop";

  let closed = false;
  let defaultHandler: (() => void) | null = null;
  const actionButtons: HTMLButtonElement[] = [];

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    panel.remove();
    backdrop.remove();
    if (opts.onClose) opts.onClose();
  };

  const setStatus = (text: string, variant: DialogStatusVariant = "default") => {
    status.className = "dialog-status" + (variant === "success" ? " success" : variant === "error" ? " error" : "");
    if (variant === "loading") {
      status.innerHTML = `<i data-lucide="loader" class="spin" style="width:12px;height:12px;"></i> ${escapeHtml(text)}`;
      refreshIcons();
    } else {
      status.textContent = text;
    }
  };
  const clearStatus = () => { status.className = "dialog-status"; status.textContent = ""; };
  const setActionsDisabled = (disabled: boolean) => {
    for (const btn of actionButtons) btn.disabled = disabled;
  };

  const runAction = async (action: DialogAction, btn: HTMLButtonElement) => {
    if (!action.onClick) { close(); return; }
    setActionsDisabled(true);
    try {
      const result = await action.onClick();
      if (result === false) {
        setActionsDisabled(false);
        return;
      }
      close();
    } catch (e) {
      setStatus(String((e as Error)?.message || e), "error");
      setActionsDisabled(false);
      btn.focus();
    }
  };

  for (const action of opts.actions || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    if (action.id) btn.id = action.id;
    if (action.variant === "danger") btn.classList.add("danger");
    if (action.variant === "primary") btn.id = btn.id || "settings-save";
    btn.addEventListener("click", () => runAction(action, btn));
    actionsEl.appendChild(btn);
    actionButtons.push(btn);
    if (action.isDefault) defaultHandler = () => runAction(action, btn);
  }

  const triggerDefault = () => { if (defaultHandler) defaultHandler(); };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (opts.persistent) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter" && defaultHandler) {
      const target = e.target as HTMLElement | null;
      // Allow Enter inside <textarea> or contenteditable to insert newlines naturally.
      if (target && (target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      // For inputs / selects / buttons / dialog body — trigger default.
      e.preventDefault();
      triggerDefault();
    }
  };

  if (!opts.persistent) {
    backdrop.addEventListener("click", close);
  }
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);

  refreshIcons();
  // Focus first focusable element in body, then first input, then default action.
  const focusable = panel.querySelector<HTMLElement>(
    "input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])",
  );
  if (focusable) focusable.focus();
  else if (actionButtons.length > 0) actionButtons[actionButtons.length - 1].focus();

  return { panel, body, close, setStatus, clearStatus, setActionsDisabled, triggerDefault };
}

/**
 * Render a simple "are you sure?" confirmation dialog. Resolves to true on confirm, false on cancel.
 */
export function confirmDialog(opts: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const handle = openDialog({
      title: opts.title,
      description: opts.description,
      actions: [
        {
          label: opts.confirmLabel,
          variant: opts.danger ? "danger" : "primary",
          isDefault: true,
          onClick: () => { decided = true; resolve(true); },
        },
        {
          label: opts.cancelLabel,
          onClick: () => { decided = true; resolve(false); },
        },
      ],
      onClose: () => { if (!decided) resolve(false); },
    });
    void handle;
  });
}
