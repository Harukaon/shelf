import { invoke } from "@tauri-apps/api/core";

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
  resize(columns: number, rows: number): void;
  clear(): void;
  write(data: string): void;
  kill(signal?: string): void;
  killAndWait(signal?: string): Promise<void>;
}

export interface IDisposable {
  dispose(): void;
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

    const invokeArgs: Record<string, unknown> = {
      file,
      args: args ?? [],
      termName: opt.name ?? "Terminal",
      cols: this.cols,
      rows: this.rows,
      cwd: opt.cwd ?? null,
      env: opt.env ?? {},
      encoding: opt.encoding ?? null,
      handleFlowControl: opt.handleFlowControl ?? null,
      flowControlPause: opt.flowControlPause ?? null,
      flowControlResume: opt.flowControlResume ?? null,
    };

    this._init = invoke<number>("pty_spawn", invokeArgs).then((pid) => {
      this.pid = pid;
      this.readLoop();
      this.waitLoop();
      return pid;
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this._init.then(() =>
      invoke("pty_resize", { pid: this.pid, cols, rows }).catch((e) =>
        console.error("Resize error:", e)
      )
    );
  }

  clear(): void {
    /* not implemented */
  }

  write(data: string): void {
    if (this._closed) return;
    this._init.then(() =>
      invoke("pty_write", { pid: this.pid, data }).catch((e) =>
        console.error("Write error:", e)
      )
    ).catch(() => {});
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

  private async readLoop() {
    await this._init;
    while (!this._closed) {
      try {
        const data: Uint8Array = await invoke("pty_read", { pid: this.pid });
        if (this._closed) return;
        for (const fn of this._onDataListeners) fn(data);
      } catch (e) {
        if (typeof e === "string" && e.includes("EOF")) return;
        console.error("Read error:", e);
        return;
      }
    }
  }

  private async waitLoop() {
    if (this._exitted || this._closed) return;
    try {
      const exitCode: number = await invoke("pty_exitstatus", { pid: this.pid });
      if (this._closed) return;
      this._exitted = true;
      for (const fn of this._onExitListeners) fn({ exitCode });
    } catch (e) {
      console.error("Exit status error:", e);
    }
  }
}

export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty {
  const argArr = typeof args === "string" ? [args] : args ?? [];
  return new Pty(file, argArr, options);
}
