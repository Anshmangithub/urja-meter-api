import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import type { Settings } from "../src/config.js";
import { PortalClient, SESSION_COOKIE } from "../src/portal.js";

export const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const SECRET = "test-secret";
const BASE = "https://portal.test";

export const testSettings = (over: Partial<Settings> = {}): Settings => ({
  portalBaseUrl: BASE,
  portalEmail: "operator@urja.local",
  portalPassword: "urja-ops-2026",
  port: 0,
  snapshotTtlMs: 900_000,
  energyTtlMs: 600_000,
  rateLimitPerMin: 1000,
  rateLimitMaxWaitMs: 20_000,
  requestTimeoutMs: 5_000,
  maxRetries: 3,
  sessionTtlMs: 3_000_000,
  portalUtcOffsetMinutes: 330,
  ...over,
});

type Failure = { status: number; body?: unknown } | Error;

/** Imitates the rules of the real portal that our client has to respect. */
export class FakePortal {
  export: any[] = fixture("export.json");
  dts: any[] = fixture("dts.json");
  energy: Record<string, any[]> = fixture("energy.json");
  sessions = new Set<string>();
  calls: string[] = [];
  logins = 0;
  /** Consumed first, one per call, for any endpoint. */
  failNext: Failure[] = [];
  dtPageSize = 20;

  readonly adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const url = new URL(config.url!, BASE);
    const respond = (status: number, data: unknown, headers: Record<string, string | string[]> = {}): AxiosResponse => ({
      status,
      statusText: String(status),
      data,
      headers,
      config,
      request: {},
    });
    const path = url.pathname;
    this.calls.push(path);

    const failure = this.failNext.shift();
    if (failure instanceof Error) throw failure;
    if (failure) return respond(failure.status, failure.body ?? { error: "boom" });

    const header = (n: string) => config.headers.get(n) as string | undefined;
    if (path === "/login") {
      const ok = header("Origin") === BASE && String(config.data).includes("urja-ops-2026");
      if (!ok) return respond(200, { type: "failure", status: 400 });
      const token = `tok${++this.logins}`;
      this.sessions.add(token);
      return respond(
        200,
        { type: "redirect", status: 303, location: "/meters" },
        { "set-cookie": [`${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly`] },
      );
    }
    const cookie = header("Cookie") ?? "";
    if (!this.sessions.has(cookie.split("=").pop() ?? "")) {
      return respond(401, { error: "unauthorized", message: "A valid session is required." });
    }
    if (path === "/portal/keys") return respond(200, { data: { signingSecret: SECRET } });
    if (path === "/portal/export") {
      return this.signatureOk(url, header) ? respond(200, { data: this.export, total: this.export.length }) : respond(401, { error: "signature_invalid" });
    }
    if (path === "/portal/dts") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const data = this.dts.slice((page - 1) * this.dtPageSize, page * this.dtPageSize);
      return respond(200, { data, total: this.dts.length, page });
    }
    const m = /^\/portal\/meters\/([^/]+)\/energy$/.exec(path);
    if (m) {
      const rows = this.energy[decodeURIComponent(m[1]!)];
      return rows ? respond(200, { data: rows }) : respond(404, { error: "not_found", message: "Meter not found" });
    }
    return respond(404, { error: "not_found" });
  };

  private signatureOk(url: URL, header: (n: string) => string | undefined): boolean {
    const ts = header("x-timestamp") ?? "";
    const want = createHmac("sha256", SECRET).update(["GET", url.pathname, url.search.slice(1), ts].join("\n")).digest("hex");
    const got = header("x-signature") ?? "";
    return (
      /^\d+$/.test(ts) &&
      Math.abs(Date.now() / 1000 - Number(ts)) < 300 &&
      got.length === want.length &&
      timingSafeEqual(Buffer.from(want), Buffer.from(got))
    );
  }

  client(settings = testSettings(), sleeps: number[] = [], now?: () => number): PortalClient {
    return new PortalClient(settings, {
      adapter: this.adapter,
      sleep: async (ms) => void sleeps.push(ms),
      now,
    });
  }
}

export const timeout = () => new AxiosError("timeout", "ECONNABORTED");
