/**
 * A small async cache: TTL, single-flight loading, stale-while-revalidate and stale-if-error.
 * Why not a library: concurrent requests for one key must cost ONE portal call, and a portal
 * outage must not become ours - most TTL caches give neither.
 */
interface Entry<V> {
  value: V;
  loadedAt: number;
}

export class AsyncCache<K, V> {
  private entries = new Map<K, Entry<V>>(); // insertion order doubles as LRU order
  private inflight = new Map<K, Promise<V>>();
  lastError: string | null = null;

  constructor(
    private readonly maxEntries = 256,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached value even if expired, without triggering any load. */
  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  /**
   * Return a fresh value, loading it if needed.
   * swr: an expired value is returned immediately while a refresh runs in the background.
   * Either way, if a refresh fails and an old value exists, the old value is served.
   */
  async get(key: K, loader: () => Promise<V>, ttlMs: number, opts: { swr?: boolean } = {}): Promise<V> {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry); // mark most recently used
      if (this.now() - entry.loadedAt < ttlMs) return entry.value;
      if (opts.swr) {
        this.start(key, loader).catch(() => undefined); // failure is recorded in lastError
        return entry.value;
      }
    }
    try {
      return await this.start(key, loader);
    } catch (err) {
      if (entry) return entry.value; // stale-if-error
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
