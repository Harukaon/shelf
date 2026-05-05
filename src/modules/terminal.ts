import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "./pty";
import { TabInfo } from "../types";
import { t } from "../i18n";

const TERMINAL_WRITE_QUIET_MS = 16;
const TERMINAL_WRITE_MAX_WAIT_MS = 120;
const TERMINAL_DEBUG_MODE = localStorage.getItem("shelf:terminal-debug") || "core";
const TERMINAL_DEBUG = TERMINAL_DEBUG_MODE !== "0";
const TERMINAL_VERBOSE_DEBUG = TERMINAL_DEBUG_MODE === "1" || TERMINAL_DEBUG_MODE === "verbose";
const SYNC_UPDATE_START = "\x1b[?2026h";
const SYNC_UPDATE_END = "\x1b[?2026l";

export function flushTabBuffer(tab: TabInfo) {
  if (tab.dataBuffer.length === 0) return;
  if (TERMINAL_VERBOSE_DEBUG) {
    console.log("[TerminalDebug] flush hidden buffer", {
      tabId: tab.id,
      chunks: tab.dataBuffer.length,
      bytes: tab.dataBuffer.reduce((sum, chunk) => sum + chunk.length, 0),
    });
  }
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
  const segments = splitSyncUpdateSequences(tab, ensureUint8Array(data));
  for (const segment of segments) {
    if (segment.type === "start") {
      tab.syncUpdateMode = true;
      if (TERMINAL_DEBUG) {
        console.log("[TerminalDebug] sync update start", { tabId: tab.id });
      }
      continue;
    }
    if (segment.type === "end") {
      if (TERMINAL_DEBUG) {
        console.log("[TerminalDebug] sync update end", {
          tabId: tab.id,
          bufferedChunks: tab.syncUpdateBuffer?.length || 0,
          bufferedBytes: (tab.syncUpdateBuffer || []).reduce((sum, chunk) => sum + chunk.length, 0),
        });
      }
      tab.syncUpdateMode = false;
      const buffered = tab.syncUpdateBuffer?.splice(0) || [];
      for (const chunk of buffered) {
        queueTerminalChunk(tab, chunk);
      }
      continue;
    }
    if (segment.data.length === 0) continue;
    if (tab.syncUpdateMode) {
      if (!tab.syncUpdateBuffer) tab.syncUpdateBuffer = [];
      tab.syncUpdateBuffer.push(segment.data);
      if (TERMINAL_VERBOSE_DEBUG) {
        console.log("[TerminalDebug] sync update buffer", {
          tabId: tab.id,
          bytes: segment.data.length,
          bufferedChunks: tab.syncUpdateBuffer.length,
          bufferedBytes: tab.syncUpdateBuffer.reduce((sum, chunk) => sum + chunk.length, 0),
        });
      }
      continue;
    }
    queueTerminalChunk(tab, segment.data);
  }
}

function queueTerminalChunk(tab: TabInfo, data: Uint8Array) {
  tab.dataBuffer.push(data.slice());
  if (!tab.writeStartedAt) tab.writeStartedAt = performance.now();
  const ansiHints = scanAnsiHints(data);
  if (TERMINAL_VERBOSE_DEBUG) {
    console.log("[TerminalDebug] pty chunk", {
      tabId: tab.id,
      bytes: data.length,
      bufferedChunks: tab.dataBuffer.length,
      bufferedBytes: tab.dataBuffer.reduce((sum, chunk) => sum + chunk.length, 0),
      sinceInputMs: tab.lastUserInputAt ? Math.round(performance.now() - tab.lastUserInputAt) : null,
      ansiHints,
      syncUpdateMode: !!tab.syncUpdateMode,
    });
  }
  scheduleTerminalWrite(tab);
}

function ensureUint8Array(data: Uint8Array | number[] | ArrayBuffer) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

function splitSyncUpdateSequences(tab: TabInfo, data: Uint8Array) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const prefix = tab.syncSequenceRemainder ? decoder.decode(tab.syncSequenceRemainder) : "";
  const text = prefix + decoder.decode(data);
  const segments: Array<{ type: "data" | "start" | "end"; data: Uint8Array }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const startIndex = text.indexOf(SYNC_UPDATE_START, cursor);
    const endIndex = text.indexOf(SYNC_UPDATE_END, cursor);
    let nextIndex = -1;
    let nextType: "start" | "end" | null = null;
    if (startIndex !== -1 && (endIndex === -1 || startIndex < endIndex)) {
      nextIndex = startIndex;
      nextType = "start";
    } else if (endIndex !== -1) {
      nextIndex = endIndex;
      nextType = "end";
    }
    if (nextIndex === -1 || !nextType) break;
    if (nextIndex > cursor) {
      segments.push({ type: "data", data: encoder.encode(text.slice(cursor, nextIndex)) });
    }
    segments.push({ type: nextType, data: new Uint8Array() });
    cursor = nextIndex + (nextType === "start" ? SYNC_UPDATE_START.length : SYNC_UPDATE_END.length);
  }
  let remainder = text.slice(cursor);
  const escapeIndex = remainder.lastIndexOf("\x1b[?2026");
  if (escapeIndex !== -1) {
    const partial = remainder.slice(escapeIndex);
    if (SYNC_UPDATE_START.startsWith(partial) || SYNC_UPDATE_END.startsWith(partial)) {
      remainder = remainder.slice(0, escapeIndex);
      tab.syncSequenceRemainder = encoder.encode(partial);
    } else {
      tab.syncSequenceRemainder = undefined;
    }
  } else {
    tab.syncSequenceRemainder = undefined;
  }
  if (remainder.length > 0) {
    segments.push({ type: "data", data: encoder.encode(remainder) });
  }
  return segments;
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
    if (TERMINAL_VERBOSE_DEBUG) {
      console.log("[TerminalDebug] write flush", {
        tabId: tab.id,
        chunks: chunks.length,
        bytes,
        sinceInputMs: tab.lastUserInputAt ? Math.round(performance.now() - tab.lastUserInputAt) : null,
      });
    }
    tab.terminal.write(combined);
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

function isWindowsPlatform() {
  return navigator.platform.toLowerCase().includes("win");
}

function cellDisplayWidth(input: string) {
  let width = 0;
  for (const char of input) {
    const code = char.codePointAt(0) || 0;
    if (
      code === 0 ||
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0xfe00 && code <= 0xfe0f)
    ) {
      continue;
    }
    width += (
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6))
    ) ? 2 : 1;
  }
  return width;
}

function estimateImeAnchor(tab: TabInfo, cellWidth: number, cellHeight: number, screen: HTMLElement) {
  const buffer = tab.terminal.buffer?.active;
  let row = Math.max(0, Math.min(tab.terminal.rows - 1, buffer?.cursorY ?? 0));
  let col = Math.max(0, Math.min(tab.terminal.cols - 1, buffer?.cursorX ?? 0));

  if (buffer) {
    const visibleTop = buffer.viewportY;
    for (let y = tab.terminal.rows - 1; y >= 0; y--) {
      const line = buffer.getLine(visibleTop + y)?.translateToString(true) || "";
      const trimmed = line.trimEnd();
      if (!trimmed.trim()) continue;
      row = y;
      col = Math.min(tab.terminal.cols - 1, Math.max(0, cellDisplayWidth(trimmed)));
      break;
    }
  }

  return {
    left: Math.max(0, Math.min(col * cellWidth, screen.clientWidth - cellWidth)),
    top: Math.max(0, Math.min(row * cellHeight, screen.clientHeight - cellHeight)),
    height: cellHeight,
  };
}

function updateWindowsImeOverlay(tab: TabInfo) {
  if (!isWindowsPlatform() || !tab.terminal?.element) return;
  const textarea = tab.terminal.textarea;
  const screen = tab.terminal.element.querySelector(".xterm-screen") as HTMLElement | null;
  const compositionView = tab.terminal.element.querySelector(".composition-view") as HTMLElement | null;
  if (!textarea || !screen || !compositionView) return;

  const dimensions = (tab.terminal as any)?._core?._renderService?.dimensions?.css;
  const cellWidth = dimensions?.cell?.width || screen.clientWidth / Math.max(1, tab.terminal.cols);
  const cellHeight = dimensions?.cell?.height || screen.clientHeight / Math.max(1, tab.terminal.rows);
  if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return;

  const anchor = estimateImeAnchor(tab, cellWidth, cellHeight, screen);
  const left = `${Math.round(anchor.left)}px`;
  const top = `${Math.round(anchor.top)}px`;
  const height = `${Math.max(1, Math.round(anchor.height))}px`;

  textarea.style.left = left;
  textarea.style.top = top;
  textarea.style.width = "1px";
  textarea.style.height = height;
  textarea.style.lineHeight = height;

  compositionView.style.left = left;
  compositionView.style.top = top;
  compositionView.style.height = height;
  compositionView.style.lineHeight = height;
}

function scheduleWindowsImeOverlayUpdate(tab: TabInfo) {
  if (!isWindowsPlatform()) return;
  requestAnimationFrame(() => updateWindowsImeOverlay(tab));
  setTimeout(() => updateWindowsImeOverlay(tab), 0);
}

function setupWindowsImeOverlay(tab: TabInfo) {
  if (!isWindowsPlatform()) return;
  const textarea = tab.terminal.textarea;
  if (!textarea) return;
  textarea.addEventListener("compositionstart", () => scheduleWindowsImeOverlayUpdate(tab));
  textarea.addEventListener("compositionupdate", () => scheduleWindowsImeOverlayUpdate(tab));
  textarea.addEventListener("input", () => scheduleWindowsImeOverlayUpdate(tab));
  textarea.addEventListener("focus", () => scheduleWindowsImeOverlayUpdate(tab));
  tab.terminal.onCursorMove(() => scheduleWindowsImeOverlayUpdate(tab));
  tab.terminal.onRender(() => {
    const compositionView = tab.terminal.element?.querySelector(".composition-view") as HTMLElement | null;
    if (compositionView?.classList.contains("active")) scheduleWindowsImeOverlayUpdate(tab);
  });
}

function scanAnsiHints(data: Uint8Array) {
  if (!TERMINAL_VERBOSE_DEBUG) return null;
  let text = "";
  try {
    text = new TextDecoder().decode(data);
  } catch (_) {
    return null;
  }
  return {
    clearScreen: text.includes("\x1b[2J") || text.includes("\x1b[J"),
    clearScrollback: text.includes("\x1b[3J"),
    homeCursor: text.includes("\x1b[H") || text.includes("\x1b[f"),
    altEnter: text.includes("\x1b[?1049h") || text.includes("\x1b[?47h"),
    altLeave: text.includes("\x1b[?1049l") || text.includes("\x1b[?47l"),
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
  if (TERMINAL_VERBOSE_DEBUG) {
    console.log("[TerminalDebug] refit", {
      tabId: tab.id,
      width,
      height,
      prevWidth: tab.lastFitWidth ?? null,
      prevHeight: tab.lastFitHeight ?? null,
      cols: dimensions.cols,
      rows: dimensions.rows,
    });
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
  if (TERMINAL_VERBOSE_DEBUG) {
    console.log("[TerminalDebug] schedule refit", {
      tabId: tab.id,
      delay,
    });
  }

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
  if (TERMINAL_VERBOSE_DEBUG) {
    console.log("[TerminalDebug] repaint", { tabId: tab.id });
  }
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
  const cmdBin = options?.command?.bin || options?.shell || "zsh";
  const cmdArgs = options?.command?.args || [];
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
    if (options?.command) {
      pty = spawn(cmdBin, cmdArgs, spawnOpts);
    } else {
      pty = spawn(cmdBin, [], spawnOpts);
    }

    const ptyInit: Promise<number> = (pty as any)._init as Promise<number>;
    console.log(`[Terminal] tab ${tabId} spawning ${cmdBin} ${cmdArgs.join(" ")} cwd=${options?.cwd}`);
    if (TERMINAL_DEBUG) {
      console.log("[TerminalDebug] create", {
        tabId,
        command: cmdBin,
        args: cmdArgs,
        scrollback: terminal.options.scrollback,
        windowsPty: (terminal.options as any).windowsPty || null,
      });
    }
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
      if (TERMINAL_VERBOSE_DEBUG) {
        console.log("[TerminalDebug] input", {
          tabId,
          length: data.length,
          preview: JSON.stringify(data).slice(0, 120),
        });
      }
      onPtyWrite(tabId, data);
    });
    if (TERMINAL_VERBOSE_DEBUG) {
      terminal.onWriteParsed(() => {
        const activeBuffer = (terminal as any).buffer?.active;
        console.log("[TerminalDebug] parsed", {
          tabId,
          cursorY: activeBuffer?.cursorY ?? null,
          viewportY: activeBuffer?.viewportY ?? null,
          baseY: activeBuffer?.baseY ?? null,
          length: activeBuffer?.length ?? null,
        });
      });
      terminal.onScroll((position: number) => {
        console.log("[TerminalDebug] scroll", { tabId, position });
      });
      terminal.onRender((range) => {
        console.log("[TerminalDebug] render", {
          tabId,
          start: range.start,
          end: range.end,
          sinceInputMs: tabInfo.lastUserInputAt ? Math.round(performance.now() - tabInfo.lastUserInputAt) : null,
        });
      });
    }
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
  setupWindowsImeOverlay(tabInfo);

  tabInfo.resizeObserver = new ResizeObserver(() => {
    if (TERMINAL_VERBOSE_DEBUG) {
      const bounds = wrapper.getBoundingClientRect();
      console.log("[TerminalDebug] resize observer", {
        tabId,
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    }
    scheduleTerminalRefit(tabInfo);
  });
  tabInfo.resizeObserver.observe(wrapper);

  terminal.onResize(() => {
    try {
      if (TERMINAL_VERBOSE_DEBUG) {
        console.log("[TerminalDebug] terminal resize", {
          tabId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      }
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
