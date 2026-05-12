/**
 * 抄自 Tabby 的 app/lib/utfSplitter.ts。
 *
 * 防止把多字节 UTF-8 字符切成两半再交给消费者。当一个 chunk 末尾正好
 * 是某个字符的前 1~3 字节时，扣下尾巴等下一个 chunk 来了再合起来发。
 */
const PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [0b110, 5, 0],
  [0b1110, 4, 1],
  [0b11110, 3, 2],
];

export class UTF8Splitter {
  private internal: Uint8Array = new Uint8Array(0);

  write(data: Uint8Array): Uint8Array {
    if (this.internal.length === 0) {
      this.internal = data;
    } else {
      const merged = new Uint8Array(this.internal.length + data.length);
      merged.set(this.internal, 0);
      merged.set(data, this.internal.length);
      this.internal = merged;
    }

    let keep = 0;
    for (const [pattern, shift, maxOffset] of PARTIALS) {
      for (let offset = 0; offset < maxOffset + 1; offset++) {
        const idx = this.internal.length - offset - 1;
        if (idx < 0) continue;
        if ((this.internal[idx] >> shift) === pattern) {
          keep = Math.max(keep, offset + 1);
        }
      }
    }

    const cutAt = this.internal.length - keep;
    const result = this.internal.slice(0, cutAt);
    this.internal = this.internal.slice(cutAt);
    return result;
  }

  flush(): Uint8Array {
    const result = this.internal;
    this.internal = new Uint8Array(0);
    return result;
  }
}
