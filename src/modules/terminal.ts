import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { spawn, IPty } from "./pty";
import { PTYDataQueue } from "./pty-queue";
import { FlowControl } from "./flow-control";
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
  const isWin = isWindows();
  // 抄 Tabby 的写法：Windows 上把 windowsPty 选项告诉 xterm.js，让它启用
  // ConPTY 专属补偿（cls 后视口对齐、resize 后光标位置修正等）。Tabby 跟
  // VS Code 都在用这个。macOS 路径完全不传 windowsPty，行为不变。
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    ...fontOptions,
    drawBoldTextInBrightColors: false,
    theme: TERMINAL_THEME,
    allowProposedApi: true,
    ...(isWin ? { windowsPty: { backend: "conpty" as const } } : {}),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  // Unicode 11 宽度表：xterm.js 默认是 Unicode 6（2010）的字符宽度，
  // Tabby 和 VS Code 都加载这个 addon 让 CJK / emoji 宽度跟现代终端
  // (Windows Terminal / ConPTY) 对齐，避免光标错位。
  try {
    const u11 = new Unicode11Addon();
    terminal.loadAddon(u11);
    terminal.unicode.activeVersion = "11";
  } catch (e) {
    console.warn("[Terminal] unicode-11 addon failed:", e);
  }

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
    // Windows: 全套抄 Tabby ——
    //   1. 立刻 ack 给 Rust 后端（pty.ackData 模式，对应 Tabby session.ts:130）
    //   2. PTYDataQueue 合并零散 chunk 成 ≤100KB 的大块，UTF-8 安全切分
    //   3. FlowControl 限制 xterm.write 速率，防止 xterm 内部解析队列爆
    //
    // macOS / Linux: 维持原来稳定的写法 —— write(data, callback)，callback
    //   触发后再 ack。用户确认 macOS 稳定，不动。
    const ptyRef = pty;
    if (isWin) {
      const flowControl = new FlowControl(terminal);
      let queue: PTYDataQueue;
      // 先声明再赋值，因为 emit 回调里要引用 queue（自己 ack 自己）。
      // queue 的 emit 把合并后的大块塞给 flowControl；
      // 立刻 ack 是为了让 queue 的内部 delta 不会卡死（真正的限流由 flowControl 做）。
      queue = new PTYDataQueue(
        (combined) => {
          if (tabInfo.active) {
            flowControl.write(combined);
          } else {
            tabInfo.dataBuffer.push(combined);
          }
          queue.ack(combined.byteLength);
        },
        () => {},
        () => {},
      );

      pty.onData((data: Uint8Array) => {
        try { ptyRef.ack(data.byteLength); } catch (_) {}
        queue.push(data);
      });

      // 退出时清理 FlowControl 的等待 promise + queue 的 timer
      pty.onExit(() => {
        try { flowControl.dispose(); } catch (_) {}
        try { queue.dispose(); } catch (_) {}
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
  // 关键：先挂到 DOM 并保持可见，再调 terminal.open()。
  // Tabby / VS Code / 裸调试终端都是这个顺序。在 visibility:hidden +
  // detached 的元素上 open()，xterm 内部测不到字体度量和容器尺寸，
  // 渲染状态会坏掉（光标错位、画面错乱）。
  // 后续 TabManager.activateTab 会按需把非活动 tab 改成 visibility:hidden。
  wrapper.style.cssText = "pointer-events:none;";
  terminalContainer.appendChild(wrapper);
  terminal.open(wrapper);
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
