export type ToastVariant = "default" | "success" | "error" | "info";

export interface ToastOptions {
  variant?: ToastVariant;
  duration?: number;
}

let containerEl: HTMLElement | null = null;
function ensureContainer(): HTMLElement {
  if (containerEl && document.body.contains(containerEl)) return containerEl;
  containerEl = document.createElement("div");
  containerEl.className = "toast-stack";
  document.body.appendChild(containerEl);
  return containerEl;
}

export function showToast(message: string, options: ToastOptions = {}): void {
  if (!message) return;
  const { variant = "default", duration = variant === "error" ? 4500 : 2500 } = options;

  const container = ensureContainer();
  const el = document.createElement("div");
  el.className = `toast toast-${variant}`;
  el.textContent = message;
  container.appendChild(el);

  // Trigger enter transition on the next frame so CSS transitions run.
  requestAnimationFrame(() => el.classList.add("show"));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.remove("show");
    el.classList.add("hide");
    setTimeout(() => el.remove(), 220);
  };

  el.addEventListener("click", dismiss);
  setTimeout(dismiss, duration);
}

export const toast = {
  show: showToast,
  success: (msg: string, duration?: number) => showToast(msg, { variant: "success", duration }),
  error: (msg: string, duration?: number) => showToast(msg, { variant: "error", duration }),
  info: (msg: string, duration?: number) => showToast(msg, { variant: "info", duration }),
};
