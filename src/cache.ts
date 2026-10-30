interface Entry<V> {
  value: V;
  loadedAt: number;
}

export class AsyncCache<K, V> {
  private entries = new Map<K, Entry<V>>();
  private inflight = new Map<K, Promise<V>>();
  lastError: string | null = null;

  constructor(
    private readonly maxEntries = 256,
    private readonly now: () => number = Date.now,
  ) {}

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  async get(key: K, loader: () => Promise<V>, ttlMs: number, opts: { swr?: boolean } = {}): Promise<V> {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      if (this.now() - entry.loadedAt < ttlMs) return entry.value;
      if (opts.swr) {
        this.start(key, loader).catch(() => undefined);
        return entry.value;
      }
    }
    try {
      return await this.start(key, loader);
    } catch (err) {
      if (entry) return entry.value;
      throw err;
    }
  }

  private start(key: K, loader: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = loader()
      .then((value) => {
        this.entries.set(key, { value, loadedAt: this.now() });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as K);
        this.lastError = null;
        return value;
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        throw err;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}
