import { describe, expect, it } from "vitest";
import { buildConsumption } from "../src/energy.js";
import { buildSnapshot, haversineKm } from "../src/snapshot.js";
import { fixture } from "./fakePortal.js";

const IST = 330;
const raw: any[] = fixture("export.json");
const dts: any[] = fixture("dts.json");
const snap = buildSnapshot(raw, dts);

describe("snapshot", () => {
  it("normalises enums to slugs", () => {
    const m = snap.meters.get("J100000")!;
    expect(m.install_status).toBe("decommissioned");
    expect(m.install_type).toBe("whole_current");
  });

  it("repairs blank hierarchy levels from siblings on the same DT, and flags it", () => {
    const blank = raw.find((m) => Object.values<any>(m.hierarchy).some((n) => !n.code || !n.name))!;
    const fixed = snap.meters.get(blank.meterId)!;
    expect(fixed.quality_flags).toContain("hierarchy_repaired");
    expect(fixed.quality_flags).not.toContain("hierarchy_incomplete");
    expect(fixed.hierarchy.path).not.toContain("?");
    const sibling = [...snap.meters.values()].find((m) => m.dt_code === fixed.dt_code && m.quality_flags.length === 0)!;
    expect(fixed.hierarchy.path).toBe(sibling.hierarchy.path);
  });

  it("uses the DT registry name for the conflicting DT-007 meters", () => {
    for (const id of ["J100400", "J100401", "J100402"]) {
      const m = snap.meters.get(id)!;
      expect(m.hierarchy.dt.name).toBe("Sanganer DT 7");
      expect(m.quality_flags).toContain("dt_name_conflict");
    }
    expect(snap.transformers.get("DT-007")!.meter_count).toBe(13);
  });

  it("flags what it cannot resolve instead of inventing it", () => {
    const lone = { ...raw[0], meterId: "J999999", dtCode: "DT-999", hierarchy: { ...raw[0].hierarchy, circle: { name: "", code: "" } } };
    const m = buildSnapshot([lone], []).meters.get("J999999")!;
    expect(m.quality_flags).toContain("hierarchy_incomplete");
    expect(m.hierarchy.circle.code).toBeNull();
    expect(m.hierarchy.path).toContain("/?/");
  });

  it("skips a malformed record and reports it", () => {
    const bad = { ...raw[0], meterId: "J000001", installStatus: "Teleported" };
    const s = buildSnapshot([bad, raw[1]], dts);
    expect(s.meters.has("J000001")).toBe(false);
    expect(s.meters.has(raw[1].meterId)).toBe(true);
    expect(s.issues.some((i) => i.kind === "record_rejected" && i.meter_id === "J000001")).toBe(true);
  });

  it("has a tree whose counts add up and whose leaves are DTs", () => {
    expect(snap.tree.reduce((n, r) => n + r.meter_count, 0)).toBe(snap.meters.size);
    const root = snap.tree[0]!;
    expect(root.meter_count).toBe(root.children.reduce((n, c) => n + c.meter_count, 0));
    let leaf = root;
    while (leaf.children.length) leaf = leaf.children[0]!;
    expect(leaf.level).toBe("dt");
  });

  it("filters", () => {
    expect(snap.search({ q: "j10000" }).map((m) => m.id)).toEqual(expect.arrayContaining(["J100000", "J100001"]));
    expect(snap.search({ make: "genus" }).every((m) => m.make === "Genus")).toBe(true);
    const p = snap.meters.get("J100000")!.hierarchy.path;
    expect(snap.search({ path: p }).every((m) => m.hierarchy.path.startsWith(p))).toBe(true);
  });

  it("finds nearby meters, nearest first, within the radius", () => {
    const { lat, lng } = snap.meters.get("J100000")!.location!;
    const hits = snap.nearby(lat, lng, 3, 10);
    expect(hits[0]!.meter.id).toBe("J100000");
    expect(hits[0]!.distance_km).toBe(0);
    expect(hits.map((h) => h.distance_km)).toEqual([...hits.map((h) => h.distance_km)].sort((a, b) => a - b));
    expect(hits.every((h) => h.distance_km <= 3)).toBe(true);
  });

  it("computes great-circle distance (Jaipur to Delhi is ~237 km)", () => {
    const d = haversineKm(26.9124, 75.7873, 28.6139, 77.209);
    expect(d).toBeGreaterThan(230);
    expect(d).toBeLessThan(245);
  });
});

describe("consumption", () => {
  const energy = fixture("energy.json");

  it("parses half-hourly readings with explicit offsets and deltas", () => {
    const rows = energy.J100000 as any[];
    const c = buildConsumption("J100000", rows, IST);
    expect(c.interval_minutes).toBe(30);
    expect(c.count).toBe(96);
    expect(c.readings[0]!.kwh_delta).toBeNull();
    expect(c.readings[1]!.kwh_delta).toBeCloseTo(Number(rows[1].kwh) - Number(rows[0].kwh), 3);
    expect(c.readings[0]!.timestamp).toBe("2026-06-01T00:00:00+05:30");
    expect(c.summary.gaps).toBe(0);
  });

  it("detects daily cadence", () => {
    const c = buildConsumption("J100042", energy.J100042, IST);
    expect(c.interval_minutes).toBe(1440);
    expect(c.summary.gaps).toBe(0);
  });

  it("copes with blanks, register resets, gaps and junk", () => {
    const rows = [
      { timestamp: "01/06/2026 00:00", kwh: "100", kvah: "110", voltR: "230" },
      { timestamp: "01/06/2026 00:30", kwh: "", kvah: "111", voltR: "231" },
      { timestamp: "01/06/2026 01:00", kwh: "101", kvah: "112", voltR: "229" },
      { timestamp: "01/06/2026 01:30", kwh: "5", kvah: "113", voltR: "230" },
      { timestamp: "01/06/2026 03:30", kwh: "6", kvah: "114", voltR: "230" },
      { timestamp: "31/02/2026 00:00", kwh: "1" },
      { timestamp: "not a date", kwh: "1" },
    ];
    const s = buildConsumption("X", rows, IST).summary;
    expect(s.missing_values).toBe(1);
    expect(s.register_resets).toBe(1);
    expect(s.gaps).toBe(1);
    expect(s.consumption_kwh).toBe(2);
  });

  it("handles an empty window", () => {
    const c = buildConsumption("X", [], IST);
    expect(c.count).toBe(0);
    expect(c.interval_minutes).toBeNull();
    expect(c.summary.consumption_kwh).toBeNull();
  });
});
