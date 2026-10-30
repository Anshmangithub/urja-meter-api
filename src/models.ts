import { z } from "zod";

export const LEVELS = ["zone", "circle", "division", "subdivision", "substation", "feeder", "dt"] as const;
export const STATUSES = ["installed", "faulty", "decommissioned"] as const;
export const PHASES = ["single", "three"] as const;
export const INSTALL_TYPES = ["whole_current", "ct_operated"] as const;
export const QUALITY_FLAGS = [
  "hierarchy_repaired",
  "hierarchy_incomplete",
  "dt_name_conflict",
  "location_missing",
  "record_rejected",
] as const;

export const LevelSchema = z.enum(LEVELS);
export const StatusSchema = z.enum(STATUSES);
export const PhaseSchema = z.enum(PHASES);
export const InstallTypeSchema = z.enum(INSTALL_TYPES);
export const QualityFlagSchema = z.enum(QUALITY_FLAGS);

export type Level = z.infer<typeof LevelSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type QualityFlag = z.infer<typeof QualityFlagSchema>;

const HierarchyRefSchema = z.object({
  code: z.string().nullable().meta({ example: "C-05" }),
  name: z.string().nullable().meta({ example: "Circle 5" }),
});
export type HierarchyRef = z.infer<typeof HierarchyRefSchema>;

export const HierarchySchema = z
  .object({
    zone: HierarchyRefSchema,
    circle: HierarchyRefSchema,
    division: HierarchyRefSchema,
    subdivision: HierarchyRefSchema,
    substation: HierarchyRefSchema,
    feeder: HierarchyRefSchema,
    dt: HierarchyRefSchema,
    path: z.string().meta({
      description:
        "Codes joined with '/', zone first. Unique per node; individual codes are not " +
        "(e.g. division D-01 exists under several circles). Unknown codes appear as '?'.",
      example: "Z-02/C-05/D-05/SD-05/SS-05/F-005/DT-005",
    }),
  })
  .meta({ id: "Hierarchy", description: "Where a meter sits in the network, zone down to distribution transformer." });
export type Hierarchy = z.infer<typeof HierarchySchema>;

const LocationSchema = z.object({ lat: z.number(), lng: z.number() }).meta({ id: "Location" });

export const MeterSchema = z
  .object({
    id: z.string().meta({ example: "J100004" }),
    serial_no: z.string(),
    make: z.string().meta({ example: "Genus" }),
    phase_type: PhaseSchema,
    install_status: StatusSchema,
    install_type: InstallTypeSchema,
    dt_code: z.string(),
    hierarchy: HierarchySchema,
    location: LocationSchema.nullable(),
    quality_flags: z.array(QualityFlagSchema).meta({
      description: "Known problems with this record in the portal data. See GET /data-quality.",
    }),
  })
  .meta({ id: "Meter" });
export type Meter = z.infer<typeof MeterSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int(), page: z.number().int(), page_size: z.number().int() });

export const NearbyMeterSchema = z
  .object({ distance_km: z.number(), meter: MeterSchema })
  .meta({ id: "NearbyMeter" });
export type NearbyMeter = z.infer<typeof NearbyMeterSchema>;

const StatusCountsSchema = z.record(StatusSchema, z.number().int());

export const TransformerSchema = z
  .object({
    code: z.string().meta({ example: "DT-007" }),
    name: z.string(),
    feeder_code: z.string(),
    capacity_kva: z.number(),
    path: z.string().nullable().meta({ description: "Hierarchy path of the DT, if any meter is on it." }),
    meter_count: z.number().int(),
    status_counts: StatusCountsSchema,
    quality_flags: z.array(QualityFlagSchema),
  })
  .meta({ id: "Transformer" });
export type Transformer = z.infer<typeof TransformerSchema>;

export interface TreeNode {
  level: Level;
  code: string | null;
  name: string | null;
  path: string;
  meter_count: number;
  status_counts: Record<Status, number>;
  children: TreeNode[];
}
export const TreeNodeSchema: z.ZodType<TreeNode> = z
  .object({
    level: LevelSchema,
    code: z.string().nullable(),
    name: z.string().nullable(),
    path: z.string().meta({ description: "Pass to GET /meters?path= to list the meters under this node." }),
    meter_count: z.number().int(),
    status_counts: StatusCountsSchema,
    get children() {
      return z.array(TreeNodeSchema);
    },
  })
  .meta({ id: "TreeNode" });

const EnergyReadingSchema = z
  .object({
    timestamp: z.iso.datetime({ offset: true }).meta({ description: "Portal local time, made explicit with an offset." }),
    kwh: z.number().nullable().meta({ description: "Cumulative import register, kWh." }),
    kvah: z.number().nullable().meta({ description: "Cumulative apparent-energy register, kVAh." }),
    voltage_r: z.number().nullable().meta({ description: "R-phase voltage, V." }),
    kwh_delta: z.number().nullable().meta({
      description:
        "kWh used since the previous reading; null for the first reading, missing values and register resets.",
    }),
    kvah_delta: z.number().nullable(),
  })
  .meta({ id: "EnergyReading" });
export type EnergyReading = z.infer<typeof EnergyReadingSchema>;

const EnergySummarySchema = z
  .object({
    consumption_kwh: z.number().nullable().meta({ description: "Sum of kwh_delta over the window." }),
    avg_voltage_r: z.number().nullable(),
    min_voltage_r: z.number().nullable(),
    max_voltage_r: z.number().nullable(),
    missing_values: z.number().int().meta({ description: "Readings with a blank kWh, kVAh or voltage." }),
    register_resets: z.number().int().meta({ description: "Readings where the cumulative kWh went down." }),
    gaps: z.number().int().meta({ description: "Places where consecutive readings are > 1.5x the cadence apart." }),
  })
  .meta({ id: "EnergySummary" });

export const ConsumptionSchema = z
  .object({
    meter_id: z.string(),
    interval_minutes: z.number().int().nullable().meta({
      description:
        "Detected reading cadence (median spacing). 30 or 1440 in practice; null with fewer than two readings.",
    }),
    count: z.number().int(),
    readings: z.array(EnergyReadingSchema),
    summary: EnergySummarySchema,
  })
  .meta({ id: "Consumption" });
export type Consumption = z.infer<typeof ConsumptionSchema>;

const SnapshotInfoSchema = z
  .object({
    fetched_at: z.iso.datetime(),
    age_seconds: z.number(),
    stale: z.boolean().meta({ description: "True if older than the TTL (a refresh is in flight or failing)." }),
  })
  .meta({ id: "SnapshotInfo" });
export type SnapshotInfo = z.infer<typeof SnapshotInfoSchema>;

export const DataQualityIssueSchema = z
  .object({ kind: QualityFlagSchema, meter_id: z.string().nullable(), detail: z.string() })
  .meta({ id: "DataQualityIssue" });
export type DataQualityIssue = z.infer<typeof DataQualityIssueSchema>;

export const DataQualityReportSchema = z
  .object({
    snapshot: SnapshotInfoSchema,
    meter_count: z.number().int(),
    counts: z.record(QualityFlagSchema, z.number().int()),
    issues: z.array(DataQualityIssueSchema),
  })
  .meta({ id: "DataQualityReport" });

export const HealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    snapshot: SnapshotInfoSchema.nullable(),
    last_refresh_error: z.string().nullable(),
    portal_session_age_seconds: z.number().nullable(),
  })
  .meta({ id: "Health" });

export const ProblemSchema = z
  .object({ error: z.string().meta({ example: "not_found" }), message: z.string() })
  .meta({ id: "Problem" });
