import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty, IPtyForkOptions } from "./pty";
import { TabInfo, SshTarget } from "../types";
import { t } from "../i18n";

type TerminalTabOptions = {
  sessionId?: string;
  sessionProvider?: "claude" | "codex";
  cwd?: string;
  workspacePath?: string;
  shell?: string;
  command?: { bin: string; args: string[] };
  onUnreadChange?: (tabId: string, hasUnread: boolean) => void;
  suppressUnreadWhile?: (tabId: string) => boolean;
  ssh?: SshTarget;
};

const COMMAND_FALLBACK_WINDOW_MS = 4_000;
const COMMAND_FALLBACK_MAX_OUTPUT = 12_000;

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellArg(value: string): string {
  // PowerShell single-quoted strings: escape embedded ' by doubling it.
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function shellNameOf(shell: string): string {
  return (shell.split(/[\\/]/).pop() || "").toLowerCase().replace(/\.exe$/, "");
}

function shellCommandLine(bin: string, args: string[], shell: string): string {
  const name = shellNameOf(shell);
  if (name === "powershell" || name === "pwsh") {
    // PowerShell needs the call operator `&` to invoke a quoted command path;
    // a bare quoted path is parsed as a string-literal expression.
    return ["&", quotePowerShellArg(bin), ...args.map(quotePowerShellArg)].join(" ");
  }
  if (name === "cmd") {
    return [quoteCmdArg(bin), ...args.map(quoteCmdArg)].join(" ");
  }
  return [bin, ...args].map(quoteShellArg).join(" ");
}

function fallbackShellForCommand(options?: TerminalTabOptions): string {
  return options?.shell || (navigator.platform.toLowerCase().includes("win") ? "powershell" : "zsh");
}

function fallbackShellArgs(shell: string): string[] {
  return loginShellArgs(shell);
}

function shouldFallbackCommand(output: string, exitCode?: number): boolean {
  if (exitCode === 0) return false;
  const normalized = output.toLowerCase();
  return (
    normalized.includes("env: node: no such file or directory") ||
    normalized.includes("node: command not found") ||
    normalized.includes("codex: command not found") ||
    normalized.includes("claude: command not found") ||
    normalized.includes("command not found: codex") ||
    normalized.includes("command not found: claude") ||
    normalized.includes("bad interpreter")
  );
}

function spawnCommandPty(
  command: { bin: string; args: string[] },
  options: TerminalTabOptions | undefined,
  terminal: Terminal,
): { pty: IPty; fallbackShell?: string; fallbackLine?: string } {
  const spawnOpts: IPtyForkOptions = { cols: terminal.cols, rows: terminal.rows };
  if (options?.cwd) spawnOpts.cwd = options.cwd;
  if (shouldRemoveInheritedNoColor(options)) {
    spawnOpts.envRemove = ["NO_COLOR"];
  }
  const pty = spawn(command.bin, command.args, spawnOpts);
  // SSH commands deliberately have no local fallback. Re-running the same
  // `ssh user@host -- ...` command in a local login shell would just connect
  // again and hit the same remote error; surface that error to the user
  // instead so they can fix the remote PATH / install the missing binary.
  if (options?.ssh) {
    return { pty };
  }
  const fallbackShell = fallbackShellForCommand(options);
  return {
    pty,
    fallbackShell,
    fallbackLine: shellCommandLine(command.bin, command.args, fallbackShell),
  };
}

function spawnShellPty(shell: string, options: TerminalTabOptions | undefined, terminal: Terminal): IPty {
  const spawnOpts: IPtyForkOptions = { cols: terminal.cols, rows: terminal.rows };
  if (options?.cwd) spawnOpts.cwd = options.cwd;
  return spawn(shell, fallbackShellArgs(shell), spawnOpts);
}

function terminalFontOptions() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) {
    return {
      fontFamily: '"SF Mono", "Menlo", monospace',
      fontWeight: 300,
      fontWeightBold: 400,
    };
  }
  if (platform.includes("win")) {
    return {
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", monospace',
      fontWeight: "normal" as const,
      fontWeightBold: "bold" as const,
    };
  }
  return {
    fontFamily: '"JetBrains Mono", "Fira Code", "DejaVu Sans Mono", monospace',
    fontWeight: "normal" as const,
    fontWeightBold: "bold" as const,
  };
}

function terminalPixelSize(tab: TabInfo) {
  const dimensions = (tab.terminal as any)?._core?._renderService?.dimensions?.css?.canvas;
  if (dimensions?.width > 0 && dimensions?.height > 0) {
    return {
      width: Math.min(65535, Math.round(dimensions.width)),
      height: Math.min(65535, Math.round(dimensions.height)),
    };
  }

  const screen = tab.terminal.element?.querySelector(".xterm-screen") as HTMLElement | null;
  const bounds = screen?.getBoundingClientRect() || tab.containerEl.getBoundingClientRect();
  return {
    width: Math.min(65535, Math.round(bounds.width)),
    height: Math.min(65535, Math.round(bounds.height)),
  };
}

function schedulePtyResize(tab: TabInfo, cols = tab.terminal.cols, rows = tab.terminal.rows) {
  if (!tab.pty || !tab.terminal || cols <= 0 || rows <= 0) return;
  if (tab.ptyResizeTimer) clearTimeout(tab.ptyResizeTimer);
  tab.ptyResizeTimer = setTimeout(() => {
    tab.ptyResizeTimer = undefined;
    if (!tab.pty || !tab.terminal) return;
    const pixels = terminalPixelSize(tab);
    tab.pty.resize(cols, rows, pixels.width, pixels.height);
  }, 100);
}

function loginShellArgs(shell: string): string[] {
  const shellName = shell.split("/").pop() || shell;
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac") && ["zsh", "bash"].includes(shellName)) return ["-l"];
  return [];
}

function applyWindowsPtyOptions(
  terminal: Terminal,
  tabId: string,
  onPtyWrite: (tabId: string, data: string) => void,
) {
  if (!navigator.platform.toLowerCase().includes("win")) return;
  // Enables xterm's WindowsPtyHeuristics — fixes TUI cursor jumping under ConPTY
  // (e.g. Claude Code's TUI input box).
  terminal.options.windowsPty = { backend: "conpty" };
  terminal.options.reflowCursorLine = true;
  // Reply to ConPTY 1.22+'s DA1 query so it doesn't stall waiting for a response.
  // Mirrors microsoft/vscode terminalInstance.ts and xterm.js own DA1 reply.
  terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      onPtyWrite(tabId, "\x1b[?61;4c");
      return true;
    }
    return false;
  });
}

/**
 * Recover input events that xterm.js 6.1.0-beta.220's `_inputEvent` drops on
 * WebKit/WKWebView (Tauri on macOS, Safari). xterm guards with
 * `(!ev.composed || !this._keyDownSeen)` and discards anything else, expecting
 * a compositionend/keypress fallback. WKWebView violates that expectation in
 * two known cases:
 *   - Chinese punctuation via IME (xtermjs/xterm.js#3070): no compositionstart
 *     / compositionend fires, so the setTimeout-based fallback never runs.
 *   - Rapid Shifted ASCII like "ASD" (xtermjs/xterm.js#5374): keypress doesn't
 *     fire for overlapping shifted keys, so `_keyPressHandled` stays false,
 *     yet the input is still dropped by the same guard.
 * VS Code doesn't hit either because Electron uses Chromium, not WKWebView.
 * Mirrors the intent of the (unmerged) PR #5614 fix.
 */
function attachWebKitInputPatch(
  wrapper: HTMLElement,
  terminal: Terminal,
  tabId: string,
  onPtyWrite: (tabId: string, data: string) => void,
) {
  // xterm 6.x public Terminal wraps internals behind `_core`. textarea has a
  // public getter, but _compositionHelper / _keyPressHandled / _keyDownSeen
  // live on the core.
  const pub = terminal as unknown as { textarea?: HTMLTextAreaElement; _core?: any };
  const core = pub._core as
    | {
        _compositionHelper?: { isComposing: boolean; _isSendingComposition?: boolean };
        _keyPressHandled?: boolean;
      }
    | undefined;
  const ta = pub.textarea;
  const comp = core?._compositionHelper;
  if (!ta || !comp || !core) return;

  let keyDownSeen = false;
  ta.addEventListener("keydown", () => { keyDownSeen = true; }, true);
  ta.addEventListener("keyup", () => { keyDownSeen = false; }, true);

  // Capture on the wrapper so we observe `input` before xterm's textarea-level
  // listener (capture phase fires parent → child).
  wrapper.addEventListener("input", (ev) => {
    if (ev.target !== ta) return;
    const ie = ev as InputEvent;
    if (ie.inputType !== "insertText" || !ie.data) return;
    if (!ie.composed || !keyDownSeen) return;     // xterm._inputEvent will fire
    if (comp.isComposing) return;                  // active IME composition
    if (comp._isSendingComposition) return;        // pending compositionend setTimeout
    if (core._keyPressHandled) return;             // xterm._keyPress already fired

    onPtyWrite(tabId, ie.data);
    ta.value = ""; // clear so xterm's _handleAnyTextareaChanges doesn't double-fire later
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
}




function shouldRemoveInheritedNoColor(options?: TerminalTabOptions): boolean {
  if (!options?.command || !options.sessionProvider) return false;
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
  return env?.DEV === true;
}

export function refitTerminal(tab: TabInfo) {
  if (!tab.fitAddon || !tab.terminal || !tab.pty || tab.containerEl.style.visibility === "hidden") return;
  const bounds = tab.containerEl.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  try {
    tab.fitAddon.fit();
    tab.terminal.refresh(0, Math.max(0, tab.terminal.rows - 1));
  } catch (_) {
    /* ignore */
  }
}

export function scheduleTerminalRefit(tab: TabInfo, delay = 80) {
  if (!tab.terminal || tab.containerEl.style.visibility === "hidden") return;

  if (!tab.resizeFrame) {
    tab.resizeFrame = requestAnimationFrame(() => {
      tab.resizeFrame = undefined;
      refitTerminal(tab);
    });
  }

  if (tab.resizeTimer) clearTimeout(tab.resizeTimer);
  if (tab.resizeFinalFrame) cancelAnimationFrame(tab.resizeFinalFrame);
  tab.resizeTimer = setTimeout(() => {
    tab.resizeFinalFrame = requestAnimationFrame(() => {
      tab.resizeFinalFrame = undefined;
      refitTerminal(tab);
    });
    tab.resizeTimer = undefined;
  }, delay);
}

export function repaintTerminal(tab: TabInfo) {
  if (!tab.terminal || tab.containerEl.style.visibility === "hidden") return;
  if (tab.resizeFrame) cancelAnimationFrame(tab.resizeFrame);
  tab.resizeFrame = requestAnimationFrame(() => {
    tab.resizeFrame = undefined;
    try {
      refitTerminal(tab);
      tab.terminal.focus();
    } catch (_) {
      /* ignore */
    }
  });
}

export type TerminalThemeMode = "dark" | "light" | "github-light" | "solarized-light" | "dracula" | "monokai";

const TERMINAL_THEMES = {
  dark: {
    background: "#282C34",
    foreground: "#DCDDDF",
    cursor: "#F3F3F4",
    selectionBackground: "#3A4250",
    black: "#2b313c",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#d19a66",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#d7dae0",
    brightBlack: "#5c6370",
    brightRed: "#e86671",
    brightGreen: "#a5d178",
    brightYellow: "#e5c07b",
    brightBlue: "#71b8ff",
    brightMagenta: "#d48bea",
    brightCyan: "#66c8d5",
    brightWhite: "#f1f3f5",
  },
  light: {
    background: "#FFFFFF",
    foreground: "#24292F",
    cursor: "#0969DA",
    selectionBackground: "#DBEAFE",
    black: "#24292F",
    red: "#CF222E",
    green: "#1A7F37",
    yellow: "#9A6700",
    blue: "#0969DA",
    magenta: "#8250DF",
    cyan: "#1B7C83",
    white: "#EAEFF2",
    brightBlack: "#6E7781",
    brightRed: "#A40E26",
    brightGreen: "#116329",
    brightYellow: "#7D4E00",
    brightBlue: "#0550AE",
    brightMagenta: "#6639BA",
    brightCyan: "#0A6B70",
    brightWhite: "#FFFFFF",
  },
  "github-light": {
    background: "#FFFFFF",
    foreground: "#24292F",
    cursor: "#0969DA",
    selectionBackground: "#DDF4FF",
    black: "#24292F",
    red: "#CF222E",
    green: "#1A7F37",
    yellow: "#9A6700",
    blue: "#0969DA",
    magenta: "#8250DF",
    cyan: "#1B7C83",
    white: "#D0D7DE",
    brightBlack: "#6E7781",
    brightRed: "#A40E26",
    brightGreen: "#116329",
    brightYellow: "#7D4E00",
    brightBlue: "#0550AE",
    brightMagenta: "#6639BA",
    brightCyan: "#0A6B70",
    brightWhite: "#F6F8FA",
  },
  "solarized-light": {
    background: "#FDF6E3",
    foreground: "#586E75",
    cursor: "#268BD2",
    selectionBackground: "#D7E7E8",
    black: "#073642",
    red: "#DC322F",
    green: "#859900",
    yellow: "#B58900",
    blue: "#268BD2",
    magenta: "#D33682",
    cyan: "#2AA198",
    white: "#EEE8D5",
    brightBlack: "#839496",
    brightRed: "#CB4B16",
    brightGreen: "#586E75",
    brightYellow: "#657B83",
    brightBlue: "#839496",
    brightMagenta: "#6C71C4",
    brightCyan: "#93A1A1",
    brightWhite: "#FDF6E3",
  },
  dracula: {
    background: "#282A36",
    foreground: "#F8F8F2",
    cursor: "#F8F8F2",
    selectionBackground: "#44475A",
    black: "#21222C",
    red: "#FF5555",
    green: "#50FA7B",
    yellow: "#F1FA8C",
    blue: "#BD93F9",
    magenta: "#FF79C6",
    cyan: "#8BE9FD",
    white: "#F8F8F2",
    brightBlack: "#6272A4",
    brightRed: "#FF6E6E",
    brightGreen: "#69FF94",
    brightYellow: "#FFFFA5",
    brightBlue: "#D6ACFF",
    brightMagenta: "#FF92DF",
    brightCyan: "#A4FFFF",
    brightWhite: "#FFFFFF",
  },
  monokai: {
    background: "#272822",
    foreground: "#F8F8F2",
    cursor: "#F8F8F0",
    selectionBackground: "#49483E",
    black: "#272822",
    red: "#F92672",
    green: "#A6E22E",
    yellow: "#E6DB74",
    blue: "#66D9EF",
    magenta: "#AE81FF",
    cyan: "#A1EFE4",
    white: "#F8F8F2",
    brightBlack: "#75715E",
    brightRed: "#F92672",
    brightGreen: "#A6E22E",
    brightYellow: "#E6DB74",
    brightBlue: "#66D9EF",
    brightMagenta: "#AE81FF",
    brightCyan: "#A1EFE4",
    brightWhite: "#F9F8F5",
  },
} satisfies Record<TerminalThemeMode, ITheme>;

let terminalThemeMode: TerminalThemeMode = "dark";

export function setTerminalThemeMode(mode: TerminalThemeMode) {
  terminalThemeMode = mode;
}

export function applyTerminalTheme(terminal: Terminal | null | undefined, mode: TerminalThemeMode = terminalThemeMode) {
  if (!terminal) return;
  terminal.options.theme = TERMINAL_THEMES[mode];
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
}

/**
 * Paste clipboard text via xterm's bracketed-paste-aware `paste()` (which fires
 * onData → onPtyWrite). This is what GUI terminals do for Ctrl+V; forwarding the
 * raw 0x16 instead makes Codex try to "paste image" and fail on text clipboards.
 */
async function pasteClipboardText(terminal: Terminal) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) terminal.paste(text);
  } catch (e) {
    console.error("[Terminal] clipboard paste failed:", e);
  }
}

export function createTerminalTab(
  tabId: string,
  title: string,
  terminalContainer: HTMLElement,
  onPtyWrite: (tabId: string, data: string) => void,
  options?: TerminalTabOptions,
): TabInfo {
  const fontOptions = terminalFontOptions();
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    ...fontOptions,
    drawBoldTextInBrightColors: false,
    theme: TERMINAL_THEMES[terminalThemeMode],
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const wrapper = document.createElement("div");
  wrapper.className = "terminal-wrapper";
  wrapper.dataset.tabId = tabId;
  wrapper.style.cssText = "visibility:hidden;pointer-events:none;";
  terminalContainer.appendChild(wrapper);
  terminal.open(wrapper);
  try {
    fitAddon.fit();
  } catch (_) {
    /* keep xterm's default 80x24 */
  }
  applyWindowsPtyOptions(terminal, tabId, onPtyWrite);
  attachWebKitInputPatch(wrapper, terminal, tabId, onPtyWrite);

  const tabInfo: TabInfo = {
    id: tabId,
    sessionId: options?.sessionId,
    sessionProvider: options?.sessionProvider,
    workspacePath: options?.workspacePath,
    cwd: options?.cwd,
    shell: options?.command ? undefined : options?.shell,
    restoreKind: options?.sessionId ? "session" : options?.command ? "new-session" : "terminal",
    title,
    closable: true,
    terminal,
    fitAddon,
    pty: undefined,
    ptyExited: false,
    containerEl: wrapper,
    active: false,
  };

  // Red-dot semantics mirror standard terminals (iTerm2 / Ghostty / Kitty):
  // light the dot when the program sends an explicit "attention" signal, not
  // on every byte. Claude Code emits OSC 9 (preferredNotifChannel=iterm2),
  // OSC 777 (Ghostty/Kitty default), or BEL (preferredNotifChannel=terminal_bell).
  // Codex CLI emits OSC 9 or BEL via tui.notification_method, on
  // agent-turn-complete / approval-requested / plan-mode-prompt. Plain zsh
  // BELs on completion errors and the `notify` option — also a legitimate
  // attention trigger.
  const markUnreadIfBackground = () => {
    if (options?.suppressUnreadWhile?.(tabId) === true) return;
    if (tabInfo.active) return;
    if (tabInfo.hasUnreadOutput) return;
    tabInfo.hasUnreadOutput = true;
    options?.onUnreadChange?.(tabId, true);
  };
  terminal.onBell(() => markUnreadIfBackground());
  // OSC 9: iTerm2 growl notification. `OSC 9 ; 4 ; ...` is iTerm2's progress
  // indicator (continuous updates during long ops) — explicitly skip that.
  terminal.parser.registerOscHandler(9, (data: string) => {
    if (!data.startsWith("4;")) markUnreadIfBackground();
    return false;
  });
  // OSC 777: rxvt-unicode / Ghostty notification. Only the `notify;` subcommand
  // is a notification; other subcodes (preexec, precmd) are shell-integration
  // hooks that fire constantly and must not light the dot.
  terminal.parser.registerOscHandler(777, (data: string) => {
    if (data.startsWith("notify;")) markUnreadIfBackground();
    return false;
  });

  let pty: IPty | undefined;
  let fallbackUsed = false;
  const spawnStartedAt = Date.now();
  let earlyOutput = "";
  const decoder = new TextDecoder();
  try {
    const commandFallback = options?.command
      ? spawnCommandPty(options.command, options, terminal)
      : undefined;
    pty = commandFallback
      ? commandFallback.pty
      : spawnShellPty(options?.shell || "zsh", options, terminal);

    const ptyInit: Promise<number> = (pty as any)._init as Promise<number>;
    const logCommand = options?.command
      ? `${options.command.bin} ${options.command.args.join(" ")}`
      : options?.shell || "zsh";
    console.log(`[Terminal] tab ${tabId} spawning ${logCommand} cwd=${options?.cwd}`);
    ptyInit
      .then((pid: number) => {
        console.log(`[Terminal] tab ${tabId} pid=${pid} ok`);
      })
      .catch((e: unknown) => {
        if (commandFallback?.fallbackShell && commandFallback.fallbackLine && !fallbackUsed) {
          fallbackUsed = true;
          console.warn(`[Terminal] tab ${tabId} direct command spawn failed, falling back to shell:`, e);
          terminal.writeln(`\r\n${t("shell.failed", String(e))}`);
          terminal.writeln("Falling back to login shell.");
          pty = spawnShellPty(commandFallback.fallbackShell, options, terminal);
          tabInfo.pty = pty;
          bindPty(pty, true);
          pty.write(`${commandFallback.fallbackLine}\r`);
          return;
        }
        console.error(`[Terminal] tab ${tabId} spawn FAILED:`, e);
        tabInfo.ptyExited = true;
        terminal.clear();
        terminal.writeln(`\r\n${t("shell.failed", String(e))}`);
        terminal.writeln("Try closing some tabs or restarting Shelf.");
      });

    tabInfo.pty = pty;

    const bindPty = (boundPty: IPty, fallback: boolean) => {
      boundPty.onData((data: Uint8Array) => {
        terminal.write(data);
        if (!fallback && commandFallback?.fallbackShell && Date.now() - spawnStartedAt <= COMMAND_FALLBACK_WINDOW_MS) {
          earlyOutput += decoder.decode(data, { stream: true });
          if (earlyOutput.length > COMMAND_FALLBACK_MAX_OUTPUT) {
            earlyOutput = earlyOutput.slice(-COMMAND_FALLBACK_MAX_OUTPUT);
          }
        }
      });
      boundPty.onExit((exit) => {
        if (!fallback && commandFallback?.fallbackShell && commandFallback.fallbackLine && !fallbackUsed && Date.now() - spawnStartedAt <= COMMAND_FALLBACK_WINDOW_MS && shouldFallbackCommand(earlyOutput, exit.exitCode)) {
          fallbackUsed = true;
          console.warn(`[Terminal] tab ${tabId} command exited early with environment error, falling back to shell.`);
          terminal.write("\r\nFalling back to login shell.\r\n");
          pty = spawnShellPty(commandFallback.fallbackShell, options, terminal);
          tabInfo.pty = pty;
          bindPty(pty, true);
          pty.write(`${commandFallback.fallbackLine}\r`);
          return;
        }
        tabInfo.ptyExited = true;
        console.log(`[Terminal] pty exited tab ${tabId} pid=${boundPty.pid} code=`, exit.exitCode, "signal:", exit.signal);
        terminal.write(`\r\n${t("process.exited")}\r\n`);
      });
    };

    bindPty(pty, false);
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
        onPtyWrite(tabId, "\x1b[13;2u");
        event.preventDefault();
        return false;
      }
      // Ctrl+V → paste clipboard *text*. Standard terminals (and Codex) treat
      // Ctrl+V as text paste, but xterm otherwise forwards a raw 0x16 that Codex
      // misreads as "paste image" → it errors with "Failed to paste image: no
      // image on clipboard" when the clipboard contains text.
      if (
        event.type === "keydown" &&
        event.ctrlKey && !event.metaKey && !event.altKey &&
        (event.code === "KeyV" || event.key === "v" || event.key === "V")
      ) {
        void pasteClipboardText(terminal);
        event.preventDefault();
        return false;
      }
      return true;
    });
    terminal.onData((data: string) => {
      onPtyWrite(tabId, data);
    });
  } catch (e) {
    tabInfo.ptyExited = true;
    console.error("Spawn PTY:", e);
    terminal.writeln(`\r\n${t("shell.failed", String(e))}`);
    terminal.writeln("Try closing some tabs or restarting Shelf.");
  }

  tabInfo.resizeObserver = new ResizeObserver(() => {
    scheduleTerminalRefit(tabInfo);
  });
  tabInfo.resizeObserver.observe(wrapper);

  terminal.onResize(() => {
    try {
      schedulePtyResize(tabInfo);
    } catch (_) {
      /* ignore */
    }
  });
  schedulePtyResize(tabInfo, terminal.cols, terminal.rows);

  return tabInfo;
}

export function writeToPty(tab: TabInfo, data: string) {
  if (tab.pty) {
    try {
      tab.pty.write(data);
    } catch (_) {
      /* ignore */
    }
  }
}
