import { createHmac } from "node:crypto";
import axios, { type AxiosAdapter, type AxiosInstance, type AxiosResponse } from "axios";
import type { Settings } from "./config.js";
import { NotFoundError, PortalAuthError, PortalProtocolError, PortalUnavailable } from "./errors.js";
import { realSleep, SlidingWindowLimiter, type Sleep } from "./ratelimit.js";

export const SESSION_COOKIE = "__Secure-better-auth.session_token";

export interface PortalDeps {
  adapter?: AxiosAdapter;
  sleep?: Sleep;
  now?: () => number;
  log?: (msg: string) => void;
}

export type RawRow = Record<string, unknown>;

export class PortalClient {
  private readonly http: AxiosInstance;
  private readonly limiter: SlidingWindowLimiter;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private cookie: string | null = null;
  private loggedInAt: number | null = null;
  private loginInFlight: Promise<void> | null = null;
  private signingSecret: string | null = null;

  constructor(
    private readonly s: Settings,
    deps: PortalDeps = {},
  ) {
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    this.http = axios.create({
      baseURL: s.portalBaseUrl,
      timeout: s.requestTimeoutMs,
      adapter: deps.adapter,
      headers: { "User-Agent": "urja-gateway/0.1", Accept: "application/json" },
      validateStatus: () => true,
      maxRedirects: 0,
    });
    this.limiter = new SlidingWindowLimiter(s.rateLimitPerMin, 60_000, s.rateLimitMaxWaitMs, this.now, this.sleep);
  }

  get sessionAgeS(): number | null {
    return this.loggedInAt === null ? null : (this.now() - this.loggedInAt) / 1000;
  }


  async exportMeters(): Promise<RawRow[]> {
    return expectList(await this.get("/portal/export", { page: 1 }, true), "/portal/export");
  }

  async listTransformers(): Promise<RawRow[]> {
    const items: RawRow[] = [];
    for (let page = 1; ; page++) {
      const body = await this.get("/portal/dts", { page });
      const batch = expectList(body, "/portal/dts");
      items.push(...batch);
      const total = Number((body as { total?: unknown }).total ?? items.length);
      if (batch.length === 0 || items.length >= total) return items;
    }
  }

  async meterEnergy(meterId: string, from?: string, to?: string): Promise<RawRow[]> {
    const query: Record<string, string> = {};
    if (from) query.from = from;
    if (to) query.to = to;
    const body = await this.get(`/portal/meters/${encodeURIComponent(meterId)}/energy`, query);
    return expectList(body, "energy");
  }


  private sessionFresh(): boolean {
    return this.loggedInAt !== null && this.now() - this.loggedInAt < this.s.sessionTtlMs;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionFresh()) return;
    this.loginInFlight ??= this.login().finally(() => {
      this.loginInFlight = null;
    });
    await this.loginInFlight;
  }

  private invalidateSession(): void {
    this.loggedInAt = null;
    this.cookie = null;
    this.signingSecret = null;
  }

  private async login(): Promise<void> {
    this.cookie = null;
    const res = await this.send("POST", "/login", {
      data: new URLSearchParams({ email: this.s.portalEmail, password: this.s.portalPassword }).toString(),
      headers: { Origin: this.s.portalBaseUrl, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const raw = res.headers["set-cookie"] as string[] | string | undefined;
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const session = cookies.map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!session) throw new PortalAuthError("Portal rejected the configured credentials.");
    this.cookie = session;
    this.loggedInAt = this.now();
    this.log(`portal login ok (status ${res.status})`);
  }

  private async signingKey(): Promise<string> {
    if (this.signingSecret === null) {
      const body = (await this.get("/portal/keys")) as { data?: { signingSecret?: unknown } };
      const secret = body?.data?.signingSecret;
      if (typeof secret !== "string") throw new PortalProtocolError("/portal/keys had an unexpected shape");
      this.signingSecret = secret;
    }
    return this.signingSecret;
  }

  private async sign(path: string, queryString: string): Promise<Record<string, string>> {
    const secret = await this.signingKey();
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret).update(["GET", path, queryString, ts].join("\n")).digest("hex");
    return { "x-timestamp": ts, "x-signature": signature };
  }


  private async get(path: string, query: Record<string, string | number> = {}, signed = false): Promise<unknown> {
    const queryString = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const url = queryString ? `${path}?${queryString}` : path;
    let relogged = false;
    let resigned = false;
    for (;;) {
      await this.ensureSession();
      const headers = signed ? await this.sign(path, queryString) : {};
      const res = await this.send("GET", url, { headers });
      const err = errorCode(res);
      if (res.status === 200) {
        if (typeof res.data !== "object" || res.data === null) throw new PortalProtocolError(`${path} returned non-JSON`);
        return res.data;
      }
      if (res.status === 401 && err === "unauthorized" && !relogged) {
        this.log("portal session rejected; logging in again");
        this.invalidateSession();
        relogged = true;
        continue;
      }
      if (res.status === 401 && err === "signature_invalid" && !resigned) {
        this.signingSecret = null;
        resigned = true;
        continue;
      }
      if (res.status === 404) throw new NotFoundError(path);
      throw new PortalProtocolError(`${path} -> HTTP ${res.status} ${err ?? ""}`.trim());
    }
  }

  private async send(
    method: "GET" | "POST",
    url: string,
    opts: { data?: string; headers?: Record<string, string> } = {},
  ): Promise<AxiosResponse> {
    for (let attempt = 1; attempt <= this.s.maxRetries; attempt++) {
      await this.limiter.acquire();
      let reason: string;
      try {
        const res = await this.http.request({
          method,
          url,
          data: opts.data,
          headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...opts.headers },
        });
        if (res.status !== 429 && res.status < 500) return res;
        reason = `HTTP ${res.status}`;
      } catch (e) {
        if (!axios.isAxiosError(e)) throw e;
        reason = e.code ?? e.name;
      }
      if (attempt === this.s.maxRetries) throw new PortalUnavailable(`Portal unavailable (${reason}) for ${url}`);
      const base = reason === "HTTP 429" ? 5000 : 500;
      const delay = Math.min(30_000, base * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);
      this.log(`portal ${reason} on ${url}; retry ${attempt} in ${Math.round(delay)}ms`);
      await this.sleep(delay);
    }
    throw new Error("unreachable");
  }
}

function errorCode(res: AxiosResponse): string | undefined {
  const d = res.data as { error?: unknown } | null;
  return d && typeof d === "object" && typeof d.error === "string" ? d.error : undefined;
}

function expectList(body: unknown, what: string): RawRow[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new PortalProtocolError(`${what} did not return {"data": [...]}`);
  return data as RawRow[];
}
