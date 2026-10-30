import { PortalUnavailable } from "./errors.js";

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SlidingWindowLimiter {
  private stamps: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxWaitMs = 20_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  acquire(): Promise<void> {
    const run = this.chain.then(() => this.take());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async take(): Promise<void> {
    let waited = 0;
    for (;;) {
      const now = this.now();
      while (this.stamps.length && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      const delay = this.windowMs - (now - this.stamps[0]!) + 10;
      if (waited + delay > this.maxWaitMs) {
        throw new PortalUnavailable("Portal request budget exhausted; try again shortly.", Math.max(1, Math.floor(delay / 1000)));
      }
      await this.sleep(delay);
      waited += delay;
    }
  }
}
