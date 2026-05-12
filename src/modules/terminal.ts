import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "./pty";
import { TabInfo } from "../types";
import { t } from "../i18n";

export function flushTabBuffer(tab: TabInfo) {
  if (tab.dataBuffer.length === 0) return;
  const chunks = tab.dataBuffer.splice(0);
  for (const chunk of chunks) {
    tab.terminal.write(chunk);
  }
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

function isWindows(): boolean {
  return navigator.platform.toLowerCase().includes("win");
}

function schedulePtyResize(tab: TabInfo, cols = tab.terminal.cols, rows = tab.terminal.rows) {
  if (!tab.pty || !tab.terminal || cols <= 0 || rows <= 0) return;
  if (tab.ptyResizeTimer) clearTimeout(tab.ptyResizeTimer);
  // Windows: ConPTY redraws the whole viewport on each resize, so we use a
  // slightly longer debounce to coalesce drag events and reduce flicker.
  // macOS / Linux: PTY resize is cheap, keep the original 100ms.
  const debounce = isWindows() ? 150 : 100;
  tab.ptyResizeTimer = setTimeout(() => {
    tab.ptyResizeTimer = undefined;
    if (!tab.pty || !tab.terminal) return;
    const pixels = terminalPixelSize(tab);
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);
    console.log(`[Terminal] tab ${tab.id} pty_resize cols=${c} rows=${r} px=${pixels.width}x${pixels.height}`);
    tab.pty.resize(c, r, pixels.width, pixels.height);
  }, debounce);
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
  options?: {
    sessionId?: string;
    cwd?: string;
    workspacePath?: string;
    shell?: string;
    command?: { bin: string; args: string[] };
    env?: Record<string, string>;
  },
): TabInfo {
  const fontOptions = terminalFontOptions();
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    ...fontOptions,
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
    if (options?.env && Object.keys(options.env).length > 0) spawnOpts.env = options.env;
    const cmdBin = options?.command?.bin || options?.shell || "zsh";
    const cmdArgs = options?.command?.args || [];
    if (options?.command) {
      pty = spawn(cmdBin, cmdArgs, spawnOpts);
    } else {
      pty = spawn(cmdBin, [], spawnOpts);
    }

    const ptyInit: Promise<number> = (pty as any)._init as Promise<number>;
    console.log(
      `[Terminal] tab ${tabId} spawning ${cmdBin} ${cmdArgs.join(" ")} cwd=${options?.cwd} envKeys=[${Object.keys(options?.env ?? {}).join(",")}]`
    );
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

    // 数据通路按平台分叉，避免影响 macOS。
    //
    // Windows: 完全对齐裸终端调试器（已证明能稳跑）—— 直接 write，立即 ack。
    //   不做 rAF 合批、不等 xterm.write 的 callback。
    // macOS / Linux: 维持原来稳定的写法 —— write(data, callback)，callback
    //   触发后再 ack。这是用户确认 macOS 稳定的实现。
    const ptyRef = pty;
    const isWinPlatform = isWindows();
    if (isWinPlatform) {
      pty.onData((data: Uint8Array) => {
        if (tabInfo.active) {
          terminal.write(data);
        } else {
          tabInfo.dataBuffer.push(data.slice());
        }
        try { ptyRef.ack(data.byteLength); } catch (_) {}
      });
    } else {
      pty.onData((data: Uint8Array) => {
        const size = data.byteLength;
        if (tabInfo.active) {
          terminal.write(data, () => {
            try { ptyRef.ack(size); } catch (_) {}
          });
        } else {
          tabInfo.dataBuffer.push(data.slice());
          try { ptyRef.ack(size); } catch (_) {}
        }
      });
    }
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
        onPtyWrite(tabId, "\x1b[13;2u");
        event.preventDefault();
        return false;
      }
      return true;
    });
    terminal.onData((data: string) => {
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

  // WebGL renderer: 裸调试终端不加载 WebGL 也能在 Windows 上稳跑。
  // 之前在 Windows 上启用 WebGL，疑似在 visibility:hidden 的 wrapper 上
  // 初始化 canvas，导致渲染状态异常。两端都用默认 DOM 渲染器。

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
