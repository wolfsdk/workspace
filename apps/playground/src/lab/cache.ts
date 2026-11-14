/**
 * Bytes of document revisions, keyed by sha256, with a byte cap. Least
 * recently used entries go first. Entries are stored and returned as copies so
 * a caller can never change what the cache holds.
 */
export class ByteCache {
  readonly #entries = new Map<string, Uint8Array<ArrayBuffer>>();
  #bytes = 0;
  readonly capBytes: number;

  constructor(capBytes: number) {
    this.capBytes = capBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(sha256: string): boolean {
    return this.#entries.has(sha256);
  }

  get(sha256: string): Uint8Array<ArrayBuffer> | undefined {
    const hit = this.#entries.get(sha256);
    if (!hit) return undefined;
    this.#entries.delete(sha256);
    this.#entries.set(sha256, hit);
    return hit.slice();
  }

  /** Stores a copy. A single entry larger than the cap is not kept. */
  set(sha256: string, bytes: Uint8Array): void {
    const old = this.#entries.get(sha256);
    if (old) {
      this.#bytes -= old.byteLength;
      this.#entries.delete(sha256);
    }
    if (bytes.byteLength > this.capBytes) return;
    this.#entries.set(sha256, bytes.slice());
    this.#bytes += bytes.byteLength;
    for (const [key, value] of this.#entries) {
      if (this.#bytes <= this.capBytes) break;
      if (key === sha256) continue;
      this.#entries.delete(key);
      this.#bytes -= value.byteLength;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}
