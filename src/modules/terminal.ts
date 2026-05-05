import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "./pty";
import { TabInfo } from "../types";
import { t } from "../i18n";

const TERMINAL_WRITE_QUIET_MS = 12;
const TERMINAL_WRITE_MAX_WAIT_MS = 80;
const TERMINAL_DEBUG = localStorage.getItem("shelf:terminal-debug") === "1";

export function flushTabBuffer(tab: TabInfo) {
  if (tab.dataBuffer.length === 0) return;
  if (tab.writeTimer) {
    clearTimeout(tab.writeTimer);
    tab.writeTimer = undefined;
  }
  if (tab.writeFrame) {
    cancelAnimationFrame(tab.writeFrame);
    tab.writeFrame = undefined;
  }
  const chunks = tab.dataBuffer.splice(0);
  for (const chunk of chunks) {
    tab.terminal.write(chunk);
  }
}

function writeTerminalData(tab: TabInfo, data: Uint8Array) {
  tab.dataBuffer.push(data.slice());
  if (!tab.writeStartedAt) tab.writeStartedAt = performance.now();
  if (TERMINAL_DEBUG) {
    console.debug("[Terminal] pty chunk", {
      tabId: tab.id,
      bytes: data.length,
      bufferedChunks: tab.dataBuffer.length,
      bufferedBytes: tab.dataBuffer.reduce((sum, chunk) => sum + chunk.length, 0),
      sinceInputMs: tab.lastUserInputAt ? Math.round(performance.now() - tab.lastUserInputAt) : null,
    });
  }
  scheduleTerminalWrite(tab);
}

function scheduleTerminalWrite(tab: TabInfo) {
  if (tab.writeTimer) clearTimeout(tab.writeTimer);
  const elapsed = tab.writeStartedAt ? performance.now() - tab.writeStartedAt : 0;
  const delay = elapsed >= TERMINAL_WRITE_MAX_WAIT_MS ? 0 : TERMINAL_WRITE_QUIET_MS;
  tab.writeTimer = setTimeout(() => {
    tab.writeTimer = undefined;
    flushTerminalWrite(tab);
  }, delay);
}

function flushTerminalWrite(tab: TabInfo) {
  if (tab.writeFrame || tab.dataBuffer.length === 0) return;
  tab.writeFrame = requestAnimationFrame(() => {
    tab.writeFrame = undefined;
    if (!tab.terminal || !tab.active) return;
    const chunks = tab.dataBuffer.splice(0);
    tab.writeStartedAt = undefined;
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    if (TERMINAL_DEBUG) {
      console.debug("[Terminal] write flush", {
        tabId: tab.id,
        chunks: chunks.length,
        bytes,
        sinceInputMs: tab.lastUserInputAt ? Math.round(performance.now() - tab.lastUserInputAt) : null,
      });
    }
    const core = (tab.terminal as any)._core;
    if (core?.writeSync && bytes <= 262_144) {
      core.writeSync(combined, 1);
    } else {
      tab.terminal.write(combined);
    }
  });
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

function terminalPlatformOptions() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) {
    return {
      windowsPty: {
        backend: "conpty" as const,
        buildNumber: 19045,
      },
    };
  }
  return {};
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

export function refitTerminal(tab: TabInfo) {
  if (!tab.fitAddon || !tab.terminal || !tab.pty || tab.containerEl.style.visibility === "hidden") return;
  const bounds = tab.containerEl.getBoundingClientRect();
  const width = Math.round(bounds.width);
  const height = Math.round(bounds.height);
  if (width <= 0 || height <= 0) return;
  const dimensions = tab.fitAddon.proposeDimensions();
  if (!dimensions || isNaN(dimensions.cols) || isNaN(dimensions.rows)) return;
  if (
    tab.lastFitWidth === width &&
    tab.lastFitHeight === height &&
    tab.terminal.cols === dimensions.cols &&
    tab.terminal.rows === dimensions.rows
  ) {
    return;
  }
  try {
    tab.fitAddon.fit();
    tab.lastFitWidth = width;
    tab.lastFitHeight = height;
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

const TERMINAL_THEME = {
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
};

export function createTerminalTab(
  tabId: string,
  title: string,
  terminalContainer: HTMLElement,
  onPtyWrite: (tabId: string, data: string) => void,
  options?: { sessionId?: string; cwd?: string; workspacePath?: string; shell?: string; command?: { bin: string; args: string[] } },
): TabInfo {
  const fontOptions = terminalFontOptions();
  const platformOptions = terminalPlatformOptions();
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    ...fontOptions,
    ...platformOptions,
    drawBoldTextInBrightColors: false,
    theme: TERMINAL_THEME,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const tabInfo: TabInfo = {
    id: tabId,
    sessionId: options?.sessionId,
    workspacePath: options?.workspacePath,
    title,
    closable: true,
    terminal,
    fitAddon,
    pty: undefined,
    containerEl: null as any,
    dataBuffer: [],
    active: false,
  };

  let pty: IPty | undefined;
  try {
    const spawnOpts: Record<string, unknown> = { cols: terminal.cols, rows: terminal.rows };
    if (options?.cwd) spawnOpts.cwd = options.cwd;
    const cmdBin = options?.command?.bin || options?.shell || "zsh";
    const cmdArgs = options?.command?.args || [];
    if (options?.command) {
      pty = spawn(cmdBin, cmdArgs, spawnOpts);
    } else {
      pty = spawn(cmdBin, [], spawnOpts);
    }

    const ptyInit: Promise<number> = (pty as any)._init as Promise<number>;
    console.log(`[Terminal] tab ${tabId} spawning ${cmdBin} ${cmdArgs.join(" ")} cwd=${options?.cwd}`);
    ptyInit
      .then((pid: number) => {
        console.log(`[Terminal] tab ${tabId} pid=${pid} ok`);
      })
      .catch((e: unknown) => {
        console.error(`[Terminal] tab ${tabId} spawn FAILED:`, e);
        terminal.clear();
        terminal.writeln(`\r\n${t("shell.failed", String(e))}`);
        terminal.writeln("Try closing some tabs or restarting Shelf.");
      });

    tabInfo.pty = pty;

    pty.onData((data: Uint8Array) => {
      if (tabInfo.active) {
        writeTerminalData(tabInfo, data);
      } else {
        tabInfo.dataBuffer.push(data.slice());
      }
    });
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.isComposing
      ) {
        onPtyWrite(tabId, "\x1b[13;2u");
        event.preventDefault();
        return false;
      }
      return true;
    });
    terminal.onData((data: string) => {
      tabInfo.lastUserInputAt = performance.now();
      onPtyWrite(tabId, data);
    });
    pty.onExit((exit) => {
      console.log(`[Terminal] pty exited tab ${tabId} pid=${pty?.pid} code=`, exit.exitCode, "signal:", exit.signal);
      terminal.write(`\r\n${t("process.exited")}\r\n`);
    });
  } catch (e) {
    console.error("Spawn PTY:", e);
    terminal.writeln(`\r\n${t("shell.failed", String(e))}`);
    terminal.writeln("Try closing some tabs or restarting Shelf.");
  }

  const wrapper = document.createElement("div");
  wrapper.className = "terminal-wrapper";
  wrapper.dataset.tabId = tabId;
  wrapper.style.cssText = "visibility:hidden;pointer-events:none;";
  terminal.open(wrapper);
  terminalContainer.appendChild(wrapper);
  tabInfo.containerEl = wrapper;

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
