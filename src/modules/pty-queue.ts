/**
 * 抄自 Tabby 的 app/lib/pty.ts 里的 PTYDataQueue。
 *
 * Tabby 把这一层放在 Electron 主进程，节流 node-pty 的输出再发到渲染进程：
 * - 把多个零散的 buffer 合并成最大 100KB 一块再发出去
 * - 维护未确认字节数（delta）。delta 超过 maxDelta 时暂停上游
 * - 渲染端 ack 之后再恢复
 *
 * 在 Shelf 里我们把这层放在 JS 渲染端，介于 Tauri Channel 和 onData 监听器
 * 之间。Tauri Channel 把 Rust 那边读到的字节推过来，PTYDataQueue 在 JS 这边
 * 再做一次合批 + 限流，确保 onData 监听者拿到的是大块的、UTF-8 边界安全的数据。
 *
 * 上游"暂停 / 恢复"映射成 invoke('pty_ack', ...) 把已消费字节告诉 Rust，
 * Rust 端按 LOW/HIGH 水位决定是否暂停 PTY reader 线程。
 */

import { UTF8Splitter } from "./utf8-splitter";

export type EmitFn = (data: Uint8Array) => void;
export type AckFn = (bytes: number) => void;

const MAX_CHUNK = 1024 * 100;       // 单次 emit 最大 100KB（与 Tabby 一致）
const MAX_DELTA = MAX_CHUNK * 5;    // 未 ack 累计上限 500KB

export class PTYDataQueue {
  private buffers: Uint8Array[] = [];
  private delta = 0;
  private flowPaused = false;
  private decoder = new UTF8Splitter();
  // Tabby 用 RxJS debounce 把残留尾巴在停流 500ms 后冲掉。
  // 这里用一个轻量的 setTimeout 即可。
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private emit: EmitFn,
    private onPause: () => void,
    private onResume: () => void,
  ) {}

  /** Rust 端推过来的原始 chunk。 */
  push(data: Uint8Array) {
    this.buffers.push(data);
    this.maybeEmit();
  }

  /** 消费者（xterm）已处理 length 字节，通知队列。 */
  ack(length: number) {
    this.delta -= length;
    if (this.delta < 0) this.delta = 0;
    this.maybeEmit();
  }

  private maybeEmit() {
    if (this.delta <= MAX_DELTA && this.flowPaused) {
      this.resume();
      return;
    }
    if (this.buffers.length > 0) {
      if (this.delta > MAX_DELTA && !this.flowPaused) {
        this.pause();
        return;
      }

      // 取出最多 MAX_CHUNK 字节，合成一块
      const toCombine: Uint8Array[] = [];
      let totalLength = 0;
      while (totalLength < MAX_CHUNK && this.buffers.length > 0) {
        totalLength += this.buffers[0].byteLength;
        toCombine.push(this.buffers.shift()!);
      }
      if (toCombine.length === 0) return;

      let combined: Uint8Array;
      if (toCombine.length === 1) {
        combined = toCombine[0];
      } else {
        combined = new Uint8Array(totalLength);
        let off = 0;
        for (const c of toCombine) {
          combined.set(c, off);
          off += c.byteLength;
        }
      }

      // 如果合并块超了 MAX_CHUNK（因最后一块过大），切回去保留余量
      if (combined.byteLength > MAX_CHUNK) {
        const head = combined.slice(0, MAX_CHUNK);
        const tail = combined.slice(MAX_CHUNK);
        this.buffers.unshift(tail);
        combined = head;
      }

      this.emitChunk(combined);
      this.delta += combined.byteLength;

      if (this.buffers.length > 0) {
        // 让出 microtask，避免独占事件循环
        Promise.resolve().then(() => this.maybeEmit());
      }
    }
  }

  private emitChunk(data: Uint8Array) {
    const safe = this.decoder.write(data);
    this.emit(safe);

    // 启动/重置 flush 计时器：流停了 500ms 后把残留尾巴冲掉
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const rest = this.decoder.flush();
      if (rest.length > 0) {
        this.emit(rest);
      }
    }, 500);
  }

  private pause() {
    this.flowPaused = true;
    try { this.onPause(); } catch (_) {}
  }

  private resume() {
    this.flowPaused = false;
    try { this.onResume(); } catch (_) {}
    this.maybeEmit();
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffers = [];
    this.decoder.flush();
  }
}
