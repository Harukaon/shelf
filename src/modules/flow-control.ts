/**
 * 抄自 Tabby 的 tabby-terminal/src/frontends/xtermFrontend.ts 里的 FlowControl 类。
 *
 * 渲染端的写入限流：防止往 xterm.js 灌数据灌得比它解析得快，
 * 让 xterm 内部的写入队列无限堆积。
 *
 * 策略：
 * - 累计写入字节数 < bytesThreshold（128KB）时直接 xterm.write(data)，
 *   不带 callback，让 xterm 走它的快速路径。
 * - 一旦累计超过阈值，改用 xterm.write(data, callback)，callback 在 xterm
 *   解析完这块数据后触发。我们用一个 pendingCallbacks 计数。
 * - pendingCallbacks > highWatermark(10) → 阻塞下一个 write 调用者
 *   （await 一个 Promise）。
 * - 当某个 callback 触发让 pendingCallbacks 跌破 lowWatermark(5) → 唤醒所有等待者。
 *
 * 为了保证写入顺序，所有 write 调用串行在一条 Promise 链上。
 */

import { Terminal } from "@xterm/xterm";

export class FlowControl {
  private blocked = false;
  private blockedWaiters: Array<() => void> = [];
  private pendingCallbacks = 0;
  private readonly lowWatermark = 5;
  private readonly highWatermark = 10;
  private bytesWritten = 0;
  private readonly bytesThreshold = 1024 * 128;

  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private xterm: Terminal) {}

  /** 串行写入，保证顺序。返回的 Promise 不必 await（写入会按顺序进行）。 */
  write(data: Uint8Array | string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const len = typeof data === "string" ? data.length : data.byteLength;
    this.writeChain = this.writeChain.then(() => this.writeOne(data, len));
    return this.writeChain;
  }

  private async writeOne(data: Uint8Array | string, len: number): Promise<void> {
    if (this.disposed) return;
    // 如果已经被高水位阻塞，等到 callback 把 pending 拖回低水位再继续
    if (this.blocked) {
      await new Promise<void>((resolve) => this.blockedWaiters.push(resolve));
      if (this.disposed) return;
    }

    this.bytesWritten += len;
    if (this.bytesWritten > this.bytesThreshold) {
      this.pendingCallbacks++;
      this.bytesWritten = 0;
      if (!this.blocked && this.pendingCallbacks > this.highWatermark) {
        this.blocked = true;
      }
      try {
        this.xterm.write(data as any, () => {
          this.pendingCallbacks--;
          if (this.blocked && this.pendingCallbacks < this.lowWatermark) {
            this.blocked = false;
            const waiters = this.blockedWaiters.splice(0);
            for (const r of waiters) {
              try { r(); } catch (_) {}
            }
          }
        });
      } catch (e) {
        this.pendingCallbacks--;
        console.warn("[FlowControl] xterm.write threw:", e);
      }
    } else {
      try {
        this.xterm.write(data as any);
      } catch (e) {
        console.warn("[FlowControl] xterm.write threw:", e);
      }
    }
  }

  dispose() {
    this.disposed = true;
    const waiters = this.blockedWaiters.splice(0);
    for (const r of waiters) {
      try { r(); } catch (_) {}
    }
  }
}
