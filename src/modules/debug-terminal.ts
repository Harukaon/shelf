/**
 * BARE DEBUG TERMINAL — diagnostic baseline.
 *
 * Goal: figure out whether the runaway-scroll / can't-type-while-streaming
 * problem on Windows is caused by Shelf's terminal-side wrappers
 * (event batching, flow-control acks, resize logic, tab visibility, WebGL,
 * unicode tables, etc) OR by something more fundamental
 * (xterm.js parser, ConPTY, the Tauri IPC pipeline).
 *
 * This module is intentionally NOT wired through pty.ts / terminal.ts /
 * TabManager. It calls the Rust commands directly with the simplest
 * possible JS wrapper:
 *
 *   1. invoke('pty_spawn', { onData: Channel })
 *   2. channel.onmessage = (raw) => terminal.write(toUint8(raw))
 *   3. terminal.onData = (s) => invoke('pty_write', { pid, data: s })
 *
 * No batching. No rAF coalescing. No ack throttling. No active/inactive
 * tab logic. No WebGL. No Unicode 11 addon. No windowsPty option. No
 * resize debounce.
 *
 * The only concession to the Rust backend's flow control: we send pty_ack
 * IMMEDIATELY on every chunk so the backend never pauses. That isolates
 * "is xterm.js / IPC the bottleneck" from "is our flow control the
 * bottleneck".
 *
 * If this bare demo ALSO infinite-scrolls on Claude --resume, then the
 * problem is xterm.js or ConPTY itself and no amount of Shelf-level
 * optimization will fix it. We'd have to either change libraries or
 * fundamentally rearchitect.
 *
 * If this bare demo works smoothly, then Shelf's wrappers are introducing
 * a bug, and we can bisect to find which layer.
 */

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

function platformShellDefault(): { bin: string; args: string[] } {
  const p = navigator.platform.toLowerCase();
  if (p.includes("win")) return { bin: "powershell.exe", args: ["-NoLogo"] };
  if (p.includes("mac")) return { bin: "zsh", args: [] };
  return { bin: "bash", args: [] };
}

interface OpenOpts {
  /** Optional default command to pre-fill the input. e.g. "claude" or claude.cmd path. */
  defaultBin?: string;
  /** Optional cwd to pre-fill. */
  defaultCwd?: string;
  /** Optional args (rare). */
  defaultArgs?: string[];
}

export function openDebugTerminal(opts: OpenOpts = {}) {
  // ----- DOM -----
  const overlay = document.createElement("div");
  overlay.id = "debug-term-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(0, 0, 0, 0.85);
    display: flex; flex-direction: column;
    font-family: "SF Mono", "Cascadia Mono", "Menlo", monospace;
  `;

  const header = document.createElement("div");
  header.style.cssText = `
    padding: 10px 14px; background: #1e1e22; color: #ddd;
    border-bottom: 1px solid #333; display: flex; gap: 8px; align-items: center;
    font-size: 12px;
  `;
  header.innerHTML = `
    <span style="font-weight:600;">DEBUG TERMINAL</span>
    <span style="opacity:0.6;">bare pipeline — no batching / no flow-control throttle / no addons</span>
    <span style="flex:1;"></span>
    <span id="debug-term-status" style="opacity:0.7;">idle</span>
    <button id="debug-term-close" style="background:#444;color:#fff;border:0;padding:4px 10px;cursor:pointer;border-radius:3px;">Close (Esc)</button>
  `;

  const ctrlRow = document.createElement("div");
  ctrlRow.style.cssText = `
    padding: 8px 14px; background: #25252a; color: #ccc;
    display: flex; gap: 8px; align-items: center; font-size: 12px;
    border-bottom: 1px solid #333;
  `;
  const defaults = platformShellDefault();
  ctrlRow.innerHTML = `
    <label style="opacity:0.7;">bin</label>
    <input id="debug-term-bin" value="${opts.defaultBin ?? defaults.bin}" style="flex:1;min-width:200px;background:#1a1a1f;color:#fff;border:1px solid #333;padding:4px 8px;font-family:inherit;font-size:12px;" />
    <label style="opacity:0.7;">args</label>
    <input id="debug-term-args" value="${(opts.defaultArgs ?? defaults.args).join(' ')}" placeholder="space-separated" style="flex:1;min-width:160px;background:#1a1a1f;color:#fff;border:1px solid #333;padding:4px 8px;font-family:inherit;font-size:12px;" />
    <label style="opacity:0.7;">cwd</label>
    <input id="debug-term-cwd" value="${opts.defaultCwd ?? ''}" placeholder="(default)" style="flex:1;min-width:160px;background:#1a1a1f;color:#fff;border:1px solid #333;padding:4px 8px;font-family:inherit;font-size:12px;" />
    <button id="debug-term-spawn" style="background:#0a84ff;color:#fff;border:0;padding:5px 14px;cursor:pointer;border-radius:3px;">Spawn</button>
  `;

  const termHost = document.createElement("div");
  termHost.style.cssText = `flex:1; min-height:0; background:#000; padding:8px;`;
  const termInner = document.createElement("div");
  termInner.style.cssText = `width:100%; height:100%;`;
  termHost.appendChild(termInner);

  overlay.appendChild(header);
  overlay.appendChild(ctrlRow);
  overlay.appendChild(termHost);
  document.body.appendChild(overlay);

  const statusEl = overlay.querySelector("#debug-term-status") as HTMLElement;
  const closeBtn = overlay.querySelector("#debug-term-close") as HTMLButtonElement;
  const spawnBtn = overlay.querySelector("#debug-term-spawn") as HTMLButtonElement;
  const binInput = overlay.querySelector("#debug-term-bin") as HTMLInputElement;
  const argsInput = overlay.querySelector("#debug-term-args") as HTMLInputElement;
  const cwdInput = overlay.querySelector("#debug-term-cwd") as HTMLInputElement;

  // ----- terminal -----
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"Cascadia Mono", "SF Mono", "Menlo", monospace',
    theme: {
      background: "#000000",
      foreground: "#e6e6e6",
      cursor: "#ffffff",
    },
    allowProposedApi: true,
    // No windowsPty, no addons beyond fit, no nothing.
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termInner);

  let pid: number | null = null;
  let killed = false;
  let chunkCount = 0;
  let totalBytes = 0;
  const setStatus = (s: string) => { statusEl.textContent = s; };

  setStatus("ready — fill in command and click Spawn");
  term.writeln("=== Debug Terminal ===");
  term.writeln("Bare pipeline. Click Spawn after filling in bin/args/cwd above.");
  term.writeln("This terminal does NOT use rAF batching, flow-control acks, WebGL, unicode11, windowsPty,");
  term.writeln("resize debounce, or any other wrapper used by normal Shelf tabs.");
  term.writeln("");

  // Initial sizing
  setTimeout(() => { try { fit.fit(); } catch (_) {} }, 50);

  const ro = new ResizeObserver(() => {
    try {
      fit.fit();
      if (pid !== null && !killed) {
        invoke("pty_resize", { pid, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    } catch (_) {}
  });
  ro.observe(termInner);

  // ----- spawn handler -----
  spawnBtn.addEventListener("click", async () => {
    if (pid !== null) {
      term.writeln("\r\n[debug] already running — close and reopen to spawn again");
      return;
    }
    const bin = binInput.value.trim();
    if (!bin) {
      term.writeln("\r\n[debug] bin is empty");
      return;
    }
    const argsRaw = argsInput.value.trim();
    const args = argsRaw ? argsRaw.split(/\s+/) : [];
    const cwd = cwdInput.value.trim() || null;

    term.clear();
    term.writeln(`[debug] spawning: ${bin} ${args.join(" ")}  (cwd=${cwd ?? "(default)"})`);
    setStatus("spawning…");

    const channel = new Channel<unknown>();
    channel.onmessage = (raw) => {
      const data = toUint8Array(raw);
      chunkCount++;
      totalBytes += data.byteLength;
      // ABSOLUTE BARE PATH: write directly, ack immediately, nothing else.
      term.write(data);
      if (pid !== null) {
        invoke("pty_ack", { pid, bytes: data.byteLength }).catch(() => {});
      }
      if (chunkCount % 100 === 0) {
        setStatus(`running pid=${pid} chunks=${chunkCount} total=${totalBytes}B`);
      }
    };

    try {
      pid = await invoke<number>("pty_spawn", {
        file: bin,
        args,
        termName: "xterm-256color",
        cols: term.cols,
        rows: term.rows,
        cwd,
        env: {},
        encoding: null,
        handleFlowControl: null,
        flowControlPause: null,
        flowControlResume: null,
        onData: channel,
      });
      setStatus(`running pid=${pid}`);
      console.log(`[debug-term] spawned pid=${pid}`);
    } catch (e) {
      term.writeln(`\r\n[debug] spawn failed: ${e}`);
      setStatus("spawn failed");
      console.error("[debug-term] spawn failed:", e);
      return;
    }

    // Forward keystrokes straight to PTY. No interception.
    term.onData((s) => {
      if (pid !== null && !killed) {
        invoke("pty_write", { pid, data: s }).catch((e) =>
          console.error("[debug-term] write error:", e)
        );
      }
    });

    // Watch exit (best-effort)
    invoke<number>("pty_exitstatus", { pid }).then((code) => {
      term.writeln(`\r\n[debug] child exited code=${code}`);
      setStatus(`exited code=${code}`);
    }).catch(() => {});
  });

  // ----- close handler -----
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
    if (e.key === "Escape" && document.activeElement?.tagName !== "INPUT") {
      cleanup();
    }
  };
  closeBtn.addEventListener("click", cleanup);
  document.addEventListener("keydown", onKey);

  term.focus();
}
