/**
 * The API surface as data. Each route declares its query schema and response schema once;
 * app.ts mounts them on Express and openapi.ts documents them from the very same definitions.
 */
import type { Response } from "express";
import { z } from "zod";
import { NotFoundError } from "./errors.js";
import type { Gateway } from "./gateway.js";
import {
  ConsumptionSchema,
  DataQualityReportSchema,
  HealthSchema,
  InstallTypeSchema,
  LEVELS,
  MeterSchema,
  NearbyMeterSchema,
  PhaseSchema,
  QUALITY_FLAGS,
  QualityFlagSchema,
  StatusSchema,
  TransformerSchema,
  TreeNodeSchema,
  pageOf,
  type TreeNode,
} from "./models.js";
import type { Snapshot } from "./snapshot.js";

export class ValidationError extends Error {}

export interface Route {
  method: "get" | "post";
  /** OpenAPI-style template, e.g. /meters/{meter_id}. */
  path: string;
  summary: string;
  tag: "Meters" | "Network" | "Operations";
  query?: z.ZodObject;
  response: z.ZodType;
  /** Error statuses this route can return beyond the common 422/502/503. */
  notFound?: boolean;
  handler(ctx: { query: any; params: Record<string, string>; res: Response }): Promise<unknown>;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), "not a real calendar date");

const pageParam = z.coerce.number().int().min(1).default(1);
const pageSizeParam = z.coerce.number().int().min(1).max(200).default(50);
const optStr = (description?: string) => z.string().min(1).optional().meta(description ? { description } : {});

const MeterListQuery = z.object({
  q: optStr("Substring of meter id or serial number."),
  status: StatusSchema.optional(),
  make: optStr("Case-insensitive, e.g. 'l&t'."),
  phase_type: PhaseSchema.optional(),
  install_type: InstallTypeSchema.optional(),
  zone: optStr(),
  circle: optStr(),
  division: optStr(),
  subdivision: optStr(),
  substation: optStr(),
  feeder: optStr(),
  dt: optStr("DT code, e.g. DT-007."),
  path: optStr(
    "Hierarchy path (from /hierarchy) to restrict to a subtree. Prefer this to the per-level codes, " +
      "which repeat under different parents.",
  ),
  quality_flag: QualityFlagSchema.optional(),
  page: pageParam,
  page_size: pageSizeParam,
});

const NearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_km: z.coerce.number().gt(0).max(500).default(2),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

const ConsumptionQuery = z.object({
  from: isoDate.optional().meta({
    description:
      "First day, inclusive (YYYY-MM-DD). Omit both bounds for the portal's default window " +
      "(about the last 7 days of available data).",
  }),
  to: isoDate.optional().meta({ description: "Last day, inclusive (YYYY-MM-DD)." }),
});

const HierarchyQuery = z.object({
  path: optStr("Return only the subtree at this path."),
  max_depth: z.coerce.number().int().min(1).max(LEVELS.length).default(LEVELS.length).meta({ description: "Levels to include." }),
});

const TransformerListQuery = z.object({
  feeder_code: optStr(),
  page: pageParam,
  page_size: pageSizeParam,
});

const paginate = <T>(items: T[], page: number, pageSize: number) => ({
  items: items.slice((page - 1) * pageSize, page * pageSize),
  total: items.length,
  page,
  page_size: pageSize,
});

export function buildRoutes(gw: Gateway): Route[] {
  /** Loads the snapshot and tells the caller how old it is. */
  const snap = async (res: Response): Promise<Snapshot> => {
    const s = await gw.snapshot();
    res.setHeader("X-Snapshot-Age", String(gw.snapshotInfo(s).age_seconds));
    return s;
  };

  return [
    {
      method: "get",
      path: "/meters",
      summary: "Search and filter meters",
      tag: "Meters",
      query: MeterListQuery,
      response: pageOf(MeterSchema),
      async handler({ query: q, res }) {
        const s = await snap(res);
        const levels = Object.fromEntries(
          LEVELS.filter((lv) => lv !== "dt" && q[lv]).map((lv) => [lv, q[lv]]),
        );
        if (q.dt) levels.dt = q.dt;
        const hits = s.search({
          q: q.q,
          status: q.status,
          make: q.make,
          phase_type: q.phase_type,
          install_type: q.install_type,
          levels,
          path: q.path,
          flag: q.quality_flag,
        });
        return paginate(hits, q.page, q.page_size);
      },
    },
    {
      method: "get",
      path: "/meters/nearby",
      summary: "Meters near a location, closest first",
      tag: "Meters",
      query: NearbyQuery,
      response: z.array(NearbyMeterSchema),
      async handler({ query: q, res }) {
        return (await snap(res)).nearby(q.lat, q.lng, q.radius_km, q.limit);
      },
    },
    {
      method: "get",
      path: "/meters/{meter_id}",
      summary: "One meter",
      tag: "Meters",
      response: MeterSchema,
      notFound: true,
      async handler({ params, res }) {
        const meter = (await snap(res)).meters.get(params.meter_id!);
        if (!meter) throw new NotFoundError(params.meter_id!);
        return meter;
      },
    },
    {
      method: "get",
      path: "/meters/{meter_id}/consumption",
      summary: "Meter readings with derived per-interval consumption",
      tag: "Meters",
      query: ConsumptionQuery,
      response: ConsumptionSchema,
      notFound: true,
      async handler({ query: q, params }) {
        if (q.from && q.to && q.from > q.to) throw new ValidationError("'from' must not be after 'to'");
        return gw.consumption(params.meter_id!, q.from, q.to);
      },
    },
    {
      method: "get",
      path: "/hierarchy",
      summary: "Network hierarchy: zone > circle > division > subdivision > substation > feeder > DT",
      tag: "Network",
      query: HierarchyQuery,
      response: z.array(TreeNodeSchema),
      notFound: true,
      async handler({ query: q, res }) {
        const s = await snap(res);
        let roots = s.tree;
        if (q.path) {
          const node = findNode(roots, q.path);
          if (!node) throw new NotFoundError(q.path);
          roots = [node];
        }
        return roots.map((n) => prune(n, q.max_depth));
      },
    },
    {
      method: "get",
      path: "/transformers",
      summary: "Distribution transformers (DT registry joined with meter counts)",
      tag: "Network",
      query: TransformerListQuery,
      response: pageOf(TransformerSchema),
      async handler({ query: q, res }) {
        const all = [...(await snap(res)).transformers.values()];
        const items = q.feeder_code ? all.filter((t) => t.feeder_code === q.feeder_code) : all;
        return paginate(items, q.page, q.page_size);
      },
    },
    {
      method: "get",
      path: "/transformers/{code}",
      summary: "One transformer",
      tag: "Network",
      response: TransformerSchema,
      notFound: true,
      async handler({ params, res }) {
        const dt = (await snap(res)).transformers.get(params.code!);
        if (!dt) throw new NotFoundError(params.code!);
        return dt;
      },
    },
    {
      method: "get",
      path: "/data-quality",
      summary: "Problems found in the portal data, and what we did about them",
      tag: "Operations",
      response: DataQualityReportSchema,
      async handler({ res }) {
        const s = await snap(res);
        const counts = Object.fromEntries(QUALITY_FLAGS.map((k) => [k, s.issues.filter((i) => i.kind === k).length]));
        return { snapshot: gw.snapshotInfo(s), meter_count: s.meters.size, counts, issues: s.issues };
      },
    },
    {
      method: "get",
      path: "/health",
      summary: "Service health (never calls the portal)",
      tag: "Operations",
      response: HealthSchema,
      async handler() {
        const s = gw.peekSnapshot();
        return {
          status: s && !gw.lastRefreshError ? "ok" : "degraded",
          snapshot: s ? gw.snapshotInfo(s) : null,
          last_refresh_error: gw.lastRefreshError,
          portal_session_age_seconds: gw.portal.sessionAgeS,
        };
      },
    },
    {
      method: "post",
      path: "/admin/refresh",
      summary: "Drop caches and re-read the portal now",
      tag: "Operations",
      response: HealthSchema,
      async handler() {
        const s = await gw.refresh();
        return {
          status: "ok",
          snapshot: gw.snapshotInfo(s),
          last_refresh_error: null,
          portal_session_age_seconds: gw.portal.sessionAgeS,
        };
      },
    },
  ];
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (path.startsWith(`${n.path}/`)) return findNode(n.children, path);
  }
  return undefined;
}

function prune(node: TreeNode, depth: number): TreeNode {
  return { ...node, children: depth <= 1 ? [] : node.children.map((c) => prune(c, depth - 1)) };
}
