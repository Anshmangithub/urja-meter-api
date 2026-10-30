import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, openApiDocument } from "../src/app.js";
import { Gateway } from "../src/gateway.js";
import { FakePortal, testSettings } from "./fakePortal.js";

let fake: FakePortal;
let gw: Gateway;
let server: Server;
let base: string;

beforeEach(async () => {
  fake = new FakePortal();
  const settings = testSettings();
  gw = new Gateway(settings, fake.client(settings));
  server = createApp(gw).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise((r) => server.close(r)));

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
};

describe("API", () => {
  it("lists, filters and paginates meters", async () => {
    const r = await get("/meters?page_size=5");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(73);
    expect(r.body.items).toHaveLength(5);
    expect(r.headers.get("x-snapshot-age")).not.toBeNull();
    const f = await get("/meters?dt=DT-007&status=installed");
    expect(f.body.items.every((m: any) => m.dt_code === "DT-007" && m.install_status === "installed")).toBe(true);
  });

  it("returns one meter, or a uniform 404", async () => {
    expect((await get("/meters/J100000")).body.id).toBe("J100000");
    const r = await get("/meters/NOPE");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });

  it("serves consumption and caches it", async () => {
    const r = await get("/meters/J100000/consumption?from=2026-06-01&to=2026-06-02");
    expect(r.status).toBe(200);
    expect(r.body.interval_minutes).toBe(30);
    await get("/meters/J100000/consumption?from=2026-06-01&to=2026-06-02");
    expect(fake.calls.filter((p) => p.endsWith("/energy"))).toHaveLength(1);
  });

  it("is stricter than the portal about bad parameters", async () => {
    const bad = await get("/meters/J100000/consumption?from=yesterday");
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("validation_error");
    expect((await get("/meters/J100000/consumption?from=2026-06-10&to=2026-06-01")).status).toBe(422);
    expect((await get("/meters/J100000/consumption?from=2026-02-31")).status).toBe(422);
    expect((await get("/meters?page_size=500")).status).toBe(422);
    expect((await get("/meters/nearby?lat=99&lng=0")).status).toBe(422);
  });

  it("does not spend a portal call on an unknown meter's consumption", async () => {
    await get("/meters/J100000");
    const before = fake.calls.length;
    expect((await get("/meters/NOPE/consumption")).status).toBe(404);
    expect(fake.calls.length).toBe(before);
  });

  it("serves the hierarchy, pruned and as a subtree that matches /meters?path=", async () => {
    const shallow = (await get("/hierarchy?max_depth=2")).body;
    expect(shallow.every((z: any) => z.children.every((c: any) => c.children.length === 0))).toBe(true);
    const path = (await get("/meters/J100000")).body.hierarchy.path;
    const sub = (await get(`/hierarchy?path=${encodeURIComponent(path)}`)).body;
    expect(sub[0].level).toBe("dt");
    expect((await get(`/meters?path=${encodeURIComponent(path)}`)).body.total).toBe(sub[0].meter_count);
    expect((await get("/hierarchy?path=Z-99")).status).toBe(404);
  });

  it("serves transformers with quality flags", async () => {
    expect((await get("/transformers")).body.total).toBe(7);
    const dt = (await get("/transformers/DT-007")).body;
    expect(dt.meter_count).toBe(13);
    expect(dt.quality_flags).toEqual(["dt_name_conflict"]);
  });

  it("reports data quality", async () => {
    const q = (await get("/data-quality")).body;
    expect(q.counts.dt_name_conflict).toBe(3);
    expect(q.counts.hierarchy_repaired).toBeGreaterThan(0);
  });

  it("finds nearby meters", async () => {
    const r = await get("/meters/nearby?lat=26.93&lng=75.83&radius_km=5");
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
  });

  it("answers 503 + Retry-After when the portal is down and nothing is cached", async () => {
    fake.failNext = Array(10).fill({ status: 503 });
    const r = await get("/meters");
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).not.toBeNull();
  });

  it("keeps serving the last snapshot through a portal outage", async () => {
    await get("/meters");
    gw.settings.snapshotTtlMs = 0; // everything is now expired
    fake.failNext = Array(20).fill({ status: 503 });
    const r = await get("/meters");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(73);
  });

  it("health never calls the portal", async () => {
    expect((await get("/health")).body.status).toBe("degraded");
    expect(fake.calls).toEqual([]);
    await get("/meters");
    expect((await get("/health")).body.status).toBe("ok");
  });

  it("returns JSON for unknown routes", async () => {
    const r = await get("/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });
});

describe("openapi.json", () => {
  it("is current (run `npm run openapi` after API changes)", () => {
    const committed = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(openApiDocument())));
  });

  it("documents every route", () => {
    const doc: any = openApiDocument();
    expect(Object.keys(doc.paths)).toHaveLength(10);
    expect(doc.openapi).toBe("3.1.0");
  });
});
