import {
  INSTALL_TYPES,
  LEVELS,
  PHASES,
  STATUSES,
  type DataQualityIssue,
  type Hierarchy,
  type HierarchyRef,
  type Level,
  type Meter,
  type NearbyMeter,
  type QualityFlag,
  type Status,
  type Transformer,
  type TreeNode,
} from "./models.js";
import type { RawRow } from "./portal.js";

export interface SearchFilters {
  q?: string;
  status?: string;
  make?: string;
  phase_type?: string;
  install_type?: string;
  levels?: Partial<Record<Level, string>>;
  path?: string;
  flag?: QualityFlag;
}

export class Snapshot {
  readonly fetchedAt = new Date();

  constructor(
    readonly meters: ReadonlyMap<string, Meter>,
    readonly transformers: ReadonlyMap<string, Transformer>,
    readonly tree: TreeNode[],
    readonly issues: DataQualityIssue[],
  ) {}

  search(f: SearchFilters): Meter[] {
    const needle = f.q?.trim().toLowerCase();
    const levels = Object.entries(f.levels ?? {}) as [Level, string][];
    const out: Meter[] = [];
    for (const m of this.meters.values()) {
      if (needle && !m.id.toLowerCase().includes(needle) && !m.serial_no.toLowerCase().includes(needle)) continue;
      if (f.status && m.install_status !== f.status) continue;
      if (f.make && m.make.toLowerCase() !== f.make.toLowerCase()) continue;
      if (f.phase_type && m.phase_type !== f.phase_type) continue;
      if (f.install_type && m.install_type !== f.install_type) continue;
      if (levels.some(([lv, code]) => m.hierarchy[lv].code !== code)) continue;
      if (f.path && m.hierarchy.path !== f.path && !m.hierarchy.path.startsWith(`${f.path}/`)) continue;
      if (f.flag && !m.quality_flags.includes(f.flag)) continue;
      out.push(m);
    }
    return out;
  }

  nearby(lat: number, lng: number, radiusKm: number, limit: number): NearbyMeter[] {
    const hits: NearbyMeter[] = [];
    for (const m of this.meters.values()) {
      if (!m.location) continue;
      const d = haversineKm(lat, lng, m.location.lat, m.location.lng);
      if (d <= radiusKm) hits.push({ distance_km: Math.round(d * 1000) / 1000, meter: m });
    }
    return hits.sort((a, b) => a.distance_km - b.distance_km).slice(0, limit);
  }
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(a));
}


export function buildSnapshot(rawMeters: RawRow[], rawDts: RawRow[]): Snapshot {
  const registry = new Map(rawDts.map((d) => [String(d.code), d]));
  const resolver = new HierarchyResolver(rawMeters);
  const issues: DataQualityIssue[] = [];
  const meters = new Map<string, Meter>();

  const sorted = [...rawMeters].sort((a, b) => String(a.meterId).localeCompare(String(b.meterId)));
  for (const raw of sorted) {
    try {
      const { meter, found } = buildMeter(raw, resolver, registry);
      meters.set(meter.id, meter);
      issues.push(...found);
    } catch (e) {
      issues.push({
        kind: "record_rejected",
        meter_id: raw.meterId == null ? null : String(raw.meterId),
        detail: `Record skipped: ${(e as Error).message.slice(0, 200)}`,
      });
    }
  }
  return new Snapshot(meters, buildTransformers(meters, registry), buildTree(meters), issues);
}

type Rec = Record<string, unknown>;

class HierarchyResolver {
  private chain = new Map<string, Set<string>>();
  private nameToCode = new Map<string, Set<string>>();
  private codeToName = new Map<string, Set<string>>();

  constructor(rawMeters: RawRow[]) {
    for (const raw of rawMeters) {
      for (const lv of LEVELS) {
        const code = field(raw, lv, "code");
        const name = field(raw, lv, "name");
        if (code) add(this.chain, `${raw.dtCode}|${lv}|code`, code);
        if (name) add(this.chain, `${raw.dtCode}|${lv}|name`, name);
        if (code && name) {
          add(this.nameToCode, `${lv}|${name}`, code);
          add(this.codeToName, `${lv}|${code}`, name);
        }
      }
    }
  }

  resolve(raw: RawRow, lv: Level): { ref: HierarchyRef; repaired: boolean } {
    let code = field(raw, lv, "code");
    let name = field(raw, lv, "name");
    let repaired = false;
    if (!code) {
      code = only(this.chain.get(`${raw.dtCode}|${lv}|code`)) ?? (name ? only(this.nameToCode.get(`${lv}|${name}`)) : "") ?? "";
      repaired ||= !!code;
    }
    if (!name) {
      name = only(this.chain.get(`${raw.dtCode}|${lv}|name`)) ?? (code ? only(this.codeToName.get(`${lv}|${code}`)) : "") ?? "";
      repaired ||= !!name;
    }
    return { ref: { code: code || null, name: name || null }, repaired };
  }
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function only(values: Set<string> | undefined): string | undefined {
  return values?.size === 1 ? [...values][0] : undefined;
}

function field(raw: RawRow, lv: Level, key: "code" | "name"): string {
  const node = (raw.hierarchy as Rec | undefined)?.[lv] as Rec | undefined;
  return String(node?.[key] ?? "").trim();
}

function buildMeter(
  raw: RawRow,
  resolver: HierarchyResolver,
  registry: Map<string, RawRow>,
): { meter: Meter; found: DataQualityIssue[] } {
  const id = required(raw, "meterId");
  const found: DataQualityIssue[] = [];
  const flags: QualityFlag[] = [];
  const issue = (kind: QualityFlag, detail: string) => found.push({ kind, meter_id: id, detail });

  const refs = {} as Record<Level, HierarchyRef>;
  const repairedLevels: Level[] = [];
  const missingLevels: Level[] = [];
  for (const lv of LEVELS) {
    const { ref, repaired } = resolver.resolve(raw, lv);
    refs[lv] = ref;
    if (repaired) repairedLevels.push(lv);
    if (!ref.code || !ref.name) missingLevels.push(lv);
  }

  const dtCode = required(raw, "dtCode");
  const observed = refs.dt.name;
  const reg = registry.get(dtCode);
  if (reg) {
    const regName = String(reg.name);
    if (observed && observed !== regName) {
      flags.push("dt_name_conflict");
      issue(
        "dt_name_conflict",
        `Meter says its DT ${dtCode} is '${observed}'; the DT registry says '${regName}'. Registry name used.`,
      );
    }
    refs.dt = { code: dtCode, name: regName };
  }
  if (repairedLevels.length) {
    flags.push("hierarchy_repaired");
    issue("hierarchy_repaired", `Blank ${repairedLevels.join(", ")} filled in from other meters on the same DT.`);
  }
  if (missingLevels.length) {
    flags.push("hierarchy_incomplete");
    issue("hierarchy_incomplete", `Could not determine code/name for: ${missingLevels.join(", ")}.`);
  }

  const geo = raw.geo as Rec | undefined;
  const lat = Number(geo?.lat);
  const lng = Number(geo?.lng);
  const validGeo = geo?.lat != null && geo?.lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!validGeo) {
    flags.push("location_missing");
    issue("location_missing", "No usable lat/lng.");
  }

  const hierarchy: Hierarchy = { ...refs, path: LEVELS.map((lv) => refs[lv].code ?? "?").join("/") };
  const meter: Meter = {
    id,
    serial_no: required(raw, "serialNo"),
    make: required(raw, "make"),
    phase_type: oneOf(PHASES, raw.phaseType, "phaseType"),
    install_status: oneOf(STATUSES, raw.installStatus, "installStatus"),
    install_type: oneOf(INSTALL_TYPES, raw.installType, "installType"),
    dt_code: dtCode,
    hierarchy,
    location: validGeo ? { lat, lng } : null,
    quality_flags: flags,
  };
  return { meter, found };
}

function required(raw: RawRow, key: string): string {
  const v = raw[key];
  if (v == null || String(v).trim() === "") throw new Error(`missing ${key}`);
  return String(v);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, field: string): T {
  const slug = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!(allowed as readonly string[]).includes(slug)) throw new Error(`unknown ${field} '${String(value)}'`);
  return slug as T;
}

function emptyCounts(): Record<Status, number> {
  return { installed: 0, faulty: 0, decommissioned: 0 };
}

function buildTransformers(meters: Map<string, Meter>, registry: Map<string, RawRow>): Map<string, Transformer> {
  const byDt = new Map<string, Meter[]>();
  for (const m of meters.values()) byDt.set(m.dt_code, [...(byDt.get(m.dt_code) ?? []), m]);
  const out = new Map<string, Transformer>();
  for (const code of [...registry.keys()].sort()) {
    const reg = registry.get(code)!;
    const ms = byDt.get(code) ?? [];
    const counts = emptyCounts();
    for (const m of ms) counts[m.install_status]++;
    out.set(code, {
      code,
      name: String(reg.name),
      feeder_code: String(reg.feederCode),
      capacity_kva: Number(reg.capacityKva),
      path: ms[0]?.hierarchy.path ?? null,
      meter_count: ms.length,
      status_counts: counts,
      quality_flags: ms.some((m) => m.quality_flags.includes("dt_name_conflict")) ? ["dt_name_conflict"] : [],
    });
  }
  return out;
}

function buildTree(meters: Map<string, Meter>): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const m of meters.values()) {
    let parent: TreeNode | undefined;
    LEVELS.forEach((lv, i) => {
      const path = LEVELS.slice(0, i + 1).map((l) => m.hierarchy[l].code ?? "?").join("/");
      let node = nodes.get(path);
      if (!node) {
        const { code, name } = m.hierarchy[lv];
        node = { level: lv, code, name, path, meter_count: 0, status_counts: emptyCounts(), children: [] };
        nodes.set(path, node);
        (parent ? parent.children : roots).push(node);
      }
      node.meter_count++;
      node.status_counts[m.install_status]++;
      parent = node;
    });
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.path.localeCompare(b.path));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
