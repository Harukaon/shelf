import { open as openExternal } from "@tauri-apps/plugin-shell";
import { escapeHtml, tauriInvoke } from "../helpers";
import { t } from "../i18n";
import { openDialog } from "./dialog";

interface UpdateInfo {
  current: string;
  latest: string;
  has_update: boolean;
  release_url: string;
  release_notes: string;
  published_at: string;
}

const SKIPPED_VERSION_KEY = "shelf.skippedUpdateVersion";

/**
 * Run on app start (with a small delay so we don't block the first paint).
 * Silent on network failure or when there's no newer release. Honors the
 * "Skip this version" choice stored in localStorage so users who explicitly
 * dismissed a version stay dismissed until something newer comes out.
 */
export function scheduleUpdateCheck(delayMs = 4_000): void {
  setTimeout(() => {
    runUpdateCheck().catch((e) => console.warn("[Shelf] update check failed:", e));
  }, delayMs);
}

async function runUpdateCheck(): Promise<void> {
  let info: UpdateInfo;
  try {
    info = await tauriInvoke<UpdateInfo>("check_for_update");
  } catch (e) {
    console.warn("[Shelf] update check skipped:", e);
    return;
  }
  if (!info.has_update) return;

  const skipped = (() => {
    try { return localStorage.getItem(SKIPPED_VERSION_KEY) || ""; }
    catch { return ""; }
  })();
  if (skipped && skipped === info.latest) return;

  showUpdateDialog(info);
}

function showUpdateDialog(info: UpdateInfo): void {
  const body = document.createElement("div");
  body.className = "update-dialog-body";

  const summary = document.createElement("div");
  summary.className = "update-dialog-summary";
  summary.innerHTML = `
    <span class="update-dialog-version current">${escapeHtml(info.current)}</span>
    <span class="update-dialog-arrow">→</span>
    <span class="update-dialog-version latest">${escapeHtml(info.latest)}</span>
    ${info.published_at ? `<span class="update-dialog-published">${escapeHtml(t("update.published", formatDate(info.published_at)))}</span>` : ""}
  `;
  body.appendChild(summary);

  const notesTitle = document.createElement("div");
  notesTitle.className = "update-dialog-notes-title";
  notesTitle.textContent = t("update.notes_title");
  body.appendChild(notesTitle);

  const notes = document.createElement("pre");
  notes.className = "update-dialog-notes";
  notes.textContent = info.release_notes.trim() || t("update.notes_empty");
  body.appendChild(notes);

  openDialog({
    title: t("update.title"),
    body,
    maxWidth: 520,
    actions: [
      {
        label: t("update.go"),
        variant: "primary",
        isDefault: true,
        onClick: () => {
          if (info.release_url) {
            openExternal(info.release_url).catch((e) => console.error("Open release URL failed:", e));
          }
        },
      },
      {
        label: t("update.skip"),
        onClick: () => {
          try { localStorage.setItem(SKIPPED_VERSION_KEY, info.latest); } catch { /* ignore */ }
        },
      },
      { label: t("update.later") },
    ],
  });
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}
