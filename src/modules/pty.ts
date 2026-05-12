import { invoke, Channel } from "@tauri-apps/api/core";

export interface IPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
  encoding?: string | null;
  handleFlowControl?: boolean;
  flowControlPause?: string;
  flowControlResume?: string;
  uid?: number;
  gid?: number;
}

export interface IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly process: string;
  handleFlowControl: boolean;
  readonly onData: (listener: (e: Uint8Array) => void) => IDisposable;
  readonly onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => IDisposable;
  resize(columns: number, rows: number, pixelWidth?: number, pixelHeight?: number): void;
  clear(): void;
  write(data: string): void;
  ack(bytes: number): void;
  kill(signal?: string): void;
  killAndWait(signal?: string): Promise<void>;
}

export interface IDisposable {
  dispose(): void;
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  // DataView / typed array
  if (data && typeof data === "object" && "buffer" in (data as any) && "byteLength" in (data as any)) {
    const d = data as { buffer: ArrayBufferLike; byteOffset?: number; byteLength: number };
    return new Uint8Array(d.buffer, d.byteOffset ?? 0, d.byteLength);
  }
  return new Uint8Array();
}

class Pty implements IPty {
  pid = 0;
  cols = 0;
  rows = 0;
  process = "";
  handleFlowControl = false;

  private _onDataListeners: Array<(e: Uint8Array) => void> = [];
  private _onExitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  private _exitted = false;
  private _closed = false;
  private _init: Promise<number>;
  private _totalReceived = 0;
  private _msgCount = 0;

  onData = (listener: (e: Uint8Array) => void): IDisposable => {
    this._onDataListeners.push(listener);
    return {
      dispose: () => {
        const i = this._onDataListeners.indexOf(listener);
        if (i !== -1) this._onDataListeners.splice(i, 1);
      },
    };
  };

  onExit = (listener: (e: { exitCode: number; signal?: number }) => void): IDisposable => {
    this._onExitListeners.push(listener);
    return {
      dispose: () => {
        const i = this._onExitListeners.indexOf(listener);
        if (i !== -1) this._onExitListeners.splice(i, 1);
      },
    };
  };

  constructor(file: string, args: string[], opt: IPtyForkOptions) {
    this.cols = opt.cols ?? 80;
    this.rows = opt.rows ?? 24;

    const onDataChannel = new Channel<unknown>();
    onDataChannel.onmessage = (raw) => {
      if (this._closed) return;
      const data = toUint8Array(raw);
      const size = data.byteLength;
      if (size === 0) return;
      this._msgCount += 1;
      this._totalReceived += size;
      if (this._msgCount <= 5 || this._msgCount % 50 === 0) {
        console.log(
          `[PTY pid=${this.pid}] chunk#${this._msgCount} size=${size} total=${this._totalReceived}B listeners=${this._onDataListeners.length}`
        );
      }
      for (const fn of this._onDataListeners) {
        try {
          fn(data);
        } catch (e) {
          console.error(`[PTY pid=${this.pid}] onData listener error:`, e);
        }
      }
    };

    const envClean: Record<string, string> = {};
    if (opt.env) {
      for (const [k, v] of Object.entries(opt.env)) {
        if (v !== undefined) envClean[k] = String(v);
      }
    }

    const invokeArgs: Record<string, unknown> = {
      file,
      args: args ?? [],
      termName: opt.name ?? "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: opt.cwd ?? null,
      env: envClean,
      encoding: opt.encoding ?? null,
      handleFlowControl: opt.handleFlowControl ?? null,
      flowControlPause: opt.flowControlPause ?? null,
      flowControlResume: opt.flowControlResume ?? null,
      onData: onDataChannel,
    };

    console.log(
      `[PTY] spawning file=${file} args=${JSON.stringify(args)} cwd=${opt.cwd ?? "(default)"} cols=${this.cols} rows=${this.rows} envKeys=[${Object.keys(envClean).join(",")}]`
    );

    this._init = invoke<number>("pty_spawn", invokeArgs).then((pid) => {
      this.pid = pid;
      console.log(`[PTY pid=${pid}] spawn ok`);
      this.waitLoop();
      return pid;
    });
  }

  resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
    if (this.cols === cols && this.rows === rows) return;
    this.cols = cols;
    this.rows = rows;
    this._init
      .then(() =>
        invoke("pty_resize", { pid: this.pid, cols, rows, pixelWidth, pixelHeight }).catch((e) =>
          console.error(`[PTY pid=${this.pid}] resize error:`, e)
        )
      )
      .catch(() => {});
  }

  clear(): void {
    /* not implemented */
  }

  write(data: string): void {
    if (this._closed) return;
    this._init
      .then(() =>
        invoke("pty_write", { pid: this.pid, data }).catch((e) =>
          console.error(`[PTY pid=${this.pid}] write error:`, e)
        )
      )
      .catch(() => {});
  }

  ack(bytes: number): void {
    if (this._closed || !this.pid || bytes <= 0) return;
    invoke("pty_ack", { pid: this.pid, bytes }).catch((e) =>
      console.error(`[PTY pid=${this.pid}] ack error:`, e)
    );
  }

  kill(): void {
    this._closed = true;
    this._onDataListeners.length = 0;
    this._onExitListeners.length = 0;
    this._init
      .then(() => invoke("pty_kill", { pid: this.pid }))
      .catch(() => {});
  }

  async killAndWait(): Promise<void> {
    this._closed = true;
    this._onDataListeners.length = 0;
    this._onExitListeners.length = 0;
    try {
      await this._init;
      await invoke("pty_kill", { pid: this.pid });
    } catch (_) {
      /* ignore */
    }
  }

  private async waitLoop() {
    if (this._exitted || this._closed) return;
    try {
      const exitCode: number = await invoke("pty_exitstatus", { pid: this.pid });
      if (this._closed) return;
      this._exitted = true;
      console.log(
        `[PTY pid=${this.pid}] exit code=${exitCode} totalReceived=${this._totalReceived}B chunks=${this._msgCount}`
      );
      for (const fn of this._onExitListeners) fn({ exitCode });
    } catch (e) {
      console.error(`[PTY pid=${this.pid}] exit status error:`, e);
    }
  }
}

export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty {
  const argArr = typeof args === "string" ? [args] : args ?? [];
  return new Pty(file, argArr, options);
}
