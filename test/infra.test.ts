import { describe, expect, it } from "vitest";
import { AsyncCache } from "../src/cache.js";
import { PortalUnavailable } from "../src/errors.js";
import { SlidingWindowLimiter } from "../src/ratelimit.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("SlidingWindowLimiter", () => {
  it("waits for the window to move", async () => {
    let t = 0;
    const slept: number[] = [];
    const lim = new SlidingWindowLimiter(2, 10_000, 30_000, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    for (let i = 0; i < 3; i++) await lim.acquire();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(10_000);
    expect(slept[0]).toBeLessThan(10_100);
  });

  it("refuses to queue for too long, and keeps working afterwards", async () => {
    let t = 0;
    const lim = new SlidingWindowLimiter(1, 60_000, 5_000, () => t, async () => undefined);
    await lim.acquire();
    const err = await lim.acquire().catch((e) => e);
    expect(err).toBeInstanceOf(PortalUnavailable);
    expect(err.retryAfterS).toBeGreaterThanOrEqual(1);
    t = 61_000;
    await expect(lim.acquire()).resolves.toBeUndefined(); // queue not poisoned
  });
});

describe("AsyncCache", () => {
  it("is single-flight", async () => {
    const cache = new AsyncCache<string, string>();
    let calls = 0;
    const load = async () => (calls++, await tick(), "v");
    const out = await Promise.all(Array.from({ length: 10 }, () => cache.get("k", load, 60_000)));
    expect(out).toEqual(Array(10).fill("v"));
    expect(calls).toBe(1);
  });

  it("expires by TTL", async () => {
    let t = 0;
    const cache = new AsyncCache<string, number>(10, () => t);
    let n = 0;
    const load = async () => ++n;
    expect(await cache.get("k", load, 10)).toBe(1);
    t = 5;
    expect(await cache.get("k", load, 10)).toBe(1);
    t = 11;
    expect(await cache.get("k", load, 10)).toBe(2);
  });

  it("serves stale on error but surfaces errors when nothing is cached", async () => {
    let t = 0;
    const cache = new AsyncCache<string, string>(10, () => t);
    await cache.get("k", async () => "old", 10);
    t = 20;
    const bad = async (): Promise<string> => {
      throw new PortalUnavailable("down");
    };
    expect(await cache.get("k", bad, 10)).toBe("old");
    expect(cache.lastError).toContain("down");
    await expect(cache.get("other", bad, 10)).rejects.toBeInstanceOf(PortalUnavailable);
  });

  it("stale-while-revalidate answers immediately and refreshes behind", async () => {
    let t = 0;
    const cache = new AsyncCache<string, number>(10, () => t);
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = async () => {
      if (++n > 1) await gate;
      return n;
    };
    await cache.get("k", load, 10, { swr: true });
    t = 20;
    expect(await cache.get("k", load, 10, { swr: true })).toBe(1);
    release();
    await tick();
    expect(await cache.get("k", load, 10, { swr: true })).toBe(2);
  });

  it("evicts least recently used", async () => {
    const cache = new AsyncCache<string, string>(2);
    for (const k of ["a", "b", "c"]) await cache.get(k, async () => k, 60_000);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("c")).toBe("c");
  });
});
