import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "./pty";
import { TabInfo } from "../types";
import { t } from "../i18n";

export function flushTabBuffer(tab: TabInfo) {
  for (const chunk of tab.dataBuffer) {
    tab.terminal.write(chunk);
  }
  tab.dataBuffer.length = 0;
}

export function refitTerminal(tab: TabInfo) {
  if (!tab.fitAddon || !tab.terminal || !tab.pty || tab.containerEl.style.visibility === "hidden") return;
  try {
    tab.fitAddon.fit();
    const { cols, rows } = tab.terminal;
    if (cols > 0 && rows > 0) tab.pty.resize(cols, rows);
  } catch (_) {
    /* ignore */
  }
}

export function repaintTerminal(tab: TabInfo) {
  if (!tab.terminal || tab.containerEl.style.visibility === "hidden") return;
  requestAnimationFrame(() => {
    try {
      refitTerminal(tab);
      tab.terminal.refresh(0, tab.terminal.rows - 1);
      tab.terminal.focus();
    } catch (_) {
      /* ignore */
    }
  });
}

const TERMINAL_THEME = {
  background: "#282C34",
  foreground: "#F3F3F4",
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
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", "Menlo", monospace',
    fontWeight: 300,
    fontWeightBold: 500,
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
        terminal.write(data);
      } else {
        tabInfo.dataBuffer.push(data);
      }
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
  wrapper.style.cssText = "width:100%;height:100%;visibility:hidden;pointer-events:none;";
  terminal.open(wrapper);
  terminalContainer.appendChild(wrapper);
  tabInfo.containerEl = wrapper;

  terminal.onResize(({ cols, rows }) => {
    if (pty && cols > 0 && rows > 0) {
      try {
        pty.resize(cols, rows);
      } catch (_) {
        /* ignore */
      }
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
