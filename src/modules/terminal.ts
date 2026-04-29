import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "tauri-pty";
import { TabInfo } from "../types";
import { t } from "../i18n";

let TERMINAL_THEME = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  selectionBackground: "#45475a",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
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
    theme: TERMINAL_THEME,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

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

    pty.onData((data: Uint8Array) => {
      terminal.write(data);
    });
    terminal.onData((data: string) => {
      console.log(`[Terminal] tab ${tabId} onData key=`, JSON.stringify(data));
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
  wrapper.style.cssText = "width:100%;height:100%;display:none;";
  terminal.open(wrapper);
  terminalContainer.appendChild(wrapper);

  terminal.onResize(({ cols, rows }) => {
    if (pty && cols > 0 && rows > 0) {
      try {
        pty.resize(cols, rows);
      } catch (_) {
        /* ignore */
      }
    }
  });

  return {
    id: tabId,
    sessionId: options?.sessionId,
    workspacePath: options?.workspacePath,
    title,
    closable: true,
    terminal,
    fitAddon,
    pty,
    containerEl: wrapper,
  };
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
