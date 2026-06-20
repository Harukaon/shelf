export const START_TAB_ID = "__start__";
export const SESSION_PAGE_SIZE = 6;
export const SESSION_POLL_INTERVAL_MS = 60_000;
export const PENDING_SESSION_POLL_INTERVAL_MS = 5_000;
export const PENDING_SESSION_DISCOVERY_TIMEOUT_MS = 120_000;
export const PENDING_SESSION_STABILIZE_MS = 45_000;
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
