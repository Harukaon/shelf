import { info, warn, error, debug } from "@tauri-apps/plugin-log";

/**
 * Mirror every `console.{log,info,warn,error,debug}` call to
 * `tauri-plugin-log` so the message ends up in the app's persistent log file
 * (and `target/debug/shelf` stdout in dev). The original console behavior is
 * preserved, so devtools/inspector still receive everything.
 *
 * Called once at startup from `app.ts` — must run before any code that logs.
 */
export function installFileLoggerBridge(): void {
  // Idempotent — protect against accidental double-install during HMR.
  const w = window as unknown as { __shelfLoggerInstalled?: boolean };
  if (w.__shelfLoggerInstalled) return;
  w.__shelfLoggerInstalled = true;

  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");

  // Plugin invocations are fire-and-forget. Swallow errors to avoid recursion
  // through console.error — the original console still gets the message.
  const send = (fn: (msg: string) => Promise<void>) => (msg: string) => {
    fn(msg).catch(() => { /* never throw from logger */ });
  };
  const toFile = {
    log: send(info),
    info: send(info),
    warn: send(warn),
    error: send(error),
    debug: send(debug),
  };

  (["log", "info", "warn", "error", "debug"] as const).forEach((level) => {
    console[level] = (...args: unknown[]) => {
      orig[level].apply(console, args as []);
      toFile[level](fmt(args));
    };
  });
}
