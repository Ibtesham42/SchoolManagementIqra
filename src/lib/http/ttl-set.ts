/**
 * Bounded in-process set with per-entry expiry (pure — unit tested). Used for negative caches on public
 * endpoints (S-04): remembering "not found" answers keeps repeated probes off the database. Per instance;
 * cleared on restart. When full, expired entries are purged first, then the oldest entry is dropped.
 */
export class TtlSet {
  private readonly entries = new Map<string, number>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  has(key: string, now = Date.now()): boolean {
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    if (expires <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, now = Date.now()): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      for (const [k, exp] of this.entries) if (exp <= now) this.entries.delete(k);
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.delete(key); // re-insert → newest
    this.entries.set(key, now + this.ttlMs);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
