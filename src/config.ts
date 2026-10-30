import { z } from "zod";

const envSchema = z.object({
  URJA_PORTAL_BASE_URL: z.url().default("https://urja-ops.flockenergy.tech"),
  URJA_PORTAL_EMAIL: z.string().min(1, "URJA_PORTAL_EMAIL is required"),
  URJA_PORTAL_PASSWORD: z.string().min(1, "URJA_PORTAL_PASSWORD is required"),
  URJA_PORT: z.coerce.number().int().positive().default(8000),
  URJA_SNAPSHOT_TTL_S: z.coerce.number().positive().default(900),
  URJA_ENERGY_TTL_S: z.coerce.number().positive().default(600),
  URJA_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(100),
  URJA_RATE_LIMIT_MAX_WAIT_S: z.coerce.number().positive().default(20),
  URJA_REQUEST_TIMEOUT_S: z.coerce.number().positive().default(20),
  URJA_MAX_RETRIES: z.coerce.number().int().min(1).default(3),
  URJA_SESSION_TTL_S: z.coerce.number().positive().default(3000),
  URJA_PORTAL_UTC_OFFSET_MINUTES: z.coerce.number().int().default(330),
});

export interface Settings {
  portalBaseUrl: string;
  portalEmail: string;
  portalPassword: string;
  port: number;
  snapshotTtlMs: number;
  energyTtlMs: number;
  rateLimitPerMin: number;
  rateLimitMaxWaitMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  sessionTtlMs: number;
  portalUtcOffsetMinutes: number;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  return {
    portalBaseUrl: e.URJA_PORTAL_BASE_URL.replace(/\/+$/, ""),
    portalEmail: e.URJA_PORTAL_EMAIL,
    portalPassword: e.URJA_PORTAL_PASSWORD,
    port: e.URJA_PORT,
    snapshotTtlMs: e.URJA_SNAPSHOT_TTL_S * 1000,
    energyTtlMs: e.URJA_ENERGY_TTL_S * 1000,
    rateLimitPerMin: e.URJA_RATE_LIMIT_PER_MIN,
    rateLimitMaxWaitMs: e.URJA_RATE_LIMIT_MAX_WAIT_S * 1000,
    requestTimeoutMs: e.URJA_REQUEST_TIMEOUT_S * 1000,
    maxRetries: e.URJA_MAX_RETRIES,
    sessionTtlMs: e.URJA_SESSION_TTL_S * 1000,
    portalUtcOffsetMinutes: e.URJA_PORTAL_UTC_OFFSET_MINUTES,
  };
}
