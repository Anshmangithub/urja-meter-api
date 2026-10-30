/** Application service: ties the portal client, caches and snapshot together. */
import { AsyncCache } from "./cache.js";
import type { Settings } from "./config.js";
import { buildConsumption } from "./energy.js";
import { NotFoundError } from "./errors.js";
import type { Consumption, SnapshotInfo } from "./models.js";
import type { PortalClient } from "./portal.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";

const SNAPSHOT_KEY = "snapshot";

export class Gateway {
  private snapshots = new AsyncCache<string, Snapshot>(1);
  private energy = new AsyncCache<string, Consumption>(256);

  constructor(
    readonly settings: Settings,
    readonly portal: PortalClient,
  ) {}

  /** Fleet data from the bulk export. Served stale while refreshing in the background. */
  snapshot(): Promise<Snapshot> {
    return this.snapshots.get(SNAPSHOT_KEY, () => this.loadSnapshot(), this.settings.snapshotTtlMs, { swr: true });
  }

  private async loadSnapshot(): Promise<Snapshot> {
    const [meters, dts] = await Promise.all([this.portal.exportMeters(), this.portal.listTransformers()]);
    return buildSnapshot(meters, dts);
  }

  /** Drop caches and re-read the portal now. */
  async refresh(): Promise<Snapshot> {
    this.snapshots.clear();
    this.energy.clear();
    return this.snapshot();
  }

  peekSnapshot(): Snapshot | undefined {
    return this.snapshots.peek(SNAPSHOT_KEY);
  }

  get lastRefreshError(): string | null {
    return this.snapshots.lastError;
  }

  snapshotInfo(snap: Snapshot): SnapshotInfo {
    const age = (Date.now() - snap.fetchedAt.getTime()) / 1000;
    return {
      fetched_at: snap.fetchedAt.toISOString(),
      age_seconds: Math.round(age * 10) / 10,
      stale: age * 1000 > this.settings.snapshotTtlMs,
    };
  }

  async consumption(meterId: string, from?: string, to?: string): Promise<Consumption> {
    // Unknown ids are rejected from the snapshot, saving a portal call.
    if (!(await this.snapshot()).meters.has(meterId)) throw new NotFoundError(meterId);
    return this.energy.get(
      JSON.stringify([meterId, from ?? null, to ?? null]),
      async () =>
        buildConsumption(meterId, await this.portal.meterEnergy(meterId, from, to), this.settings.portalUtcOffsetMinutes),
      this.settings.energyTtlMs,
    );
  }
}
