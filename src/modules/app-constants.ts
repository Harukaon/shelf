export const START_TAB_ID = "__start__";
export const SESSION_PAGE_SIZE = 6;
export const SESSION_POLL_INTERVAL_MS = 60_000;
export const PENDING_SESSION_POLL_INTERVAL_MS = 5_000;
export const PENDING_SESSION_DISCOVERY_TIMEOUT_MS = 120_000;
export const PENDING_SESSION_STABILIZE_MS = 45_000;
// A session tab whose PTY produces no output for this long (and is not the
// active tab) is put to sleep: its `claude --resume` process is killed to
// reclaim memory/SWAP, while the tab + session id are kept so it can be
// respawned on demand when the user revisits it. Running turns keep
// producing output and thus keep refreshing lastDataAt, so active work is
// never interrupted.
export const DORMANT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DORMANT_SCAN_INTERVAL_MS = 60_000;
export const THEME_STORAGE_KEY = "shelf.theme";

export type AppTheme = "dark" | "light" | "github-light" | "solarized-light" | "dracula" | "monokai";

export const APP_THEMES = new Set<AppTheme>([
  "dark",
  "light",
  "github-light",
  "solarized-light",
  "dracula",
  "monokai",
]);
