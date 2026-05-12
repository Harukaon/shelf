// 裸终端调试窗口：打开就是一个能用的 shell，没有任何 Shelf 包装层。
// 用来对比：如果在这里跑 claude 也炸，说明 xterm.js / ConPTY 本身扛不住；
// 如果不炸，说明 Shelf 的某层包装有问题。

import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (data && typeof data === "object" && "buffer" in (data as any) && "byteLength" in (data as any)) {
    const d = data as { buffer: ArrayBufferLike; byteOffset?: number; byteLength: number };
    return new Uint8Array(d.buffer, d.byteOffset ?? 0, d.byteLength);
  }
  return new Uint8Array();
}

function defaultShell(): { bin: string; args: string[] } {
  const p = navigator.platform.toLowerCase();
  if (p.includes("win")) return { bin: "powershell.exe", args: ["-NoLogo"] };
  if (p.includes("mac")) return { bin: "zsh", args: ["-l"] };
  return { bin: "bash", args: ["-l"] };
}

export function openDebugTerminal(opts: { defaultCwd?: string } = {}) {
  // 覆盖层
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 99999;
    background: #000;
    display: flex; flex-direction: column;
  `;

  // 顶栏：只留一个关闭按钮
  const bar = document.createElement("div");
  bar.style.cssText = `
    padding: 6px 12px; background: #1a1a1a; color: #888;
    display: flex; gap: 10px; align-items: center;
    font-family: system-ui, sans-serif; font-size: 12px;
    border-bottom: 1px solid #2a2a2a;
  `;
  bar.innerHTML = `
    <span>🐛 裸终端（无任何 Shelf 包装层）</span>
    <span style="flex:1"></span>
    <span id="dbg-status" style="opacity:0.6;"></span>
    <button id="dbg-close" style="background:#333;color:#fff;border:0;padding:5px 12px;cursor:pointer;border-radius:3px;">关闭 (Esc)</button>
  `;

  // 终端容器
  const termHost = document.createElement("div");
  termHost.style.cssText = `flex:1; min-height:0; background:#000; padding:6px;`;
  const termInner = document.createElement("div");
  termInner.style.cssText = `width:100%; height:100%;`;
  termHost.appendChild(termInner);

  overlay.appendChild(bar);
  overlay.appendChild(termHost);
  document.body.appendChild(overlay);

  const statusEl = overlay.querySelector("#dbg-status") as HTMLElement;
  const closeBtn = overlay.querySelector("#dbg-close") as HTMLButtonElement;

  // xterm，最朴素配置
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"Cascadia Mono", "SF Mono", "Menlo", monospace',
    theme: { background: "#000000", foreground: "#e6e6e6", cursor: "#ffffff" },
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termInner);
  setTimeout(() => { try { fit.fit(); } catch (_) {} }, 30);

  let pid: number | null = null;
  let killed = false;

  // 立刻 spawn 一个 shell，不再让用户填表
  const shell = defaultShell();
  const channel = new Channel<unknown>();

  channel.onmessage = (raw) => {
    if (killed) return;
    const data = toUint8Array(raw);
    // 裸：直接 write，立刻 ack，啥也不做
    term.write(data);
    if (pid !== null) {
      invoke("pty_ack", { pid, bytes: data.byteLength }).catch(() => {});
    }
  };

  const spawn = async () => {
    statusEl.textContent = "启动中…";
    try {
      pid = await invoke<number>("pty_spawn", {
        file: shell.bin,
        args: shell.args,
        termName: "xterm-256color",
        cols: term.cols,
        rows: term.rows,
        cwd: opts.defaultCwd ?? null,
        env: {},
        encoding: null,
        handleFlowControl: null,
        flowControlPause: null,
        flowControlResume: null,
        onData: channel,
      });
      statusEl.textContent = `pid=${pid}`;
      console.log(`[debug-term] spawned pid=${pid}, shell=${shell.bin}`);
    } catch (e) {
      term.writeln(`\r\n启动失败: ${e}`);
      statusEl.textContent = "启动失败";
      console.error("[debug-term] spawn failed:", e);
      return;
    }

    // 键盘输入直接转发给 PTY
    term.onData((s) => {
      if (pid !== null && !killed) {
        invoke("pty_write", { pid, data: s }).catch(() => {});
      }
    });

    // 子进程退出
    invoke<number>("pty_exitstatus", { pid }).then((code) => {
      term.writeln(`\r\n[进程退出 code=${code}]`);
      statusEl.textContent = `已退出 code=${code}`;
    }).catch(() => {});
  };

  // resize 转发，无 debounce
  const ro = new ResizeObserver(() => {
    try {
      fit.fit();
      if (pid !== null && !killed) {
        invoke("pty_resize", { pid, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    } catch (_) {}
  });
  ro.observe(termInner);

  // 关闭逻辑
  const cleanup = () => {
    killed = true;
    try { ro.disconnect(); } catch (_) {}
    if (pid !== null) {
      invoke("pty_kill", { pid }).catch(() => {});
    }
    try { term.dispose(); } catch (_) {}
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };
  closeBtn.addEventListener("click", cleanup);
  document.addEventListener("keydown", onKey);

  term.focus();
  spawn();
}
