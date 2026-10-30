import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, PortalAuthError, PortalProtocolError, PortalUnavailable } from "../src/errors.js";
import { FakePortal, testSettings, timeout } from "./fakePortal.js";

let fake: FakePortal;
let sleeps: number[];
beforeEach(() => {
  fake = new FakePortal();
  sleeps = [];
});

describe("PortalClient", () => {
  it("logs in and signs the bulk export", async () => {
    const c = fake.client(undefined, sleeps);
    const meters = await c.exportMeters();
    expect(meters).toHaveLength(fake.export.length);
    expect(fake.logins).toBe(1);
    expect(fake.calls.filter((p) => p === "/portal/keys")).toHaveLength(1);
  });

  it("reuses the session", async () => {
    const c = fake.client();
    await c.exportMeters();
    await c.listTransformers();
    expect(fake.logins).toBe(1);
  });

  it("shares one login between concurrent requests", async () => {
    const c = fake.client();
    await Promise.all([c.listTransformers(), c.listTransformers(), c.listTransformers()]);
    expect(fake.logins).toBe(1);
  });

  it("logs in again when the portal forgets the session mid-flight", async () => {
    const c = fake.client();
    await c.exportMeters();
    fake.sessions.clear(); // the 1h expiry
    expect(await c.exportMeters()).toBeTruthy();
    expect(fake.logins).toBe(2);
  });

  it("renews proactively before the cookie expires", async () => {
    let now = 0;
    const c = fake.client(testSettings(), sleeps, () => now);
    await c.listTransformers();
    now = testSettings().sessionTtlMs + 1;
    await c.listTransformers();
    expect(fake.logins).toBe(2);
  });

  it("reports bad credentials as a non-retryable auth error", async () => {
    const c = fake.client(testSettings({ portalPassword: "wrong" }));
    await expect(c.exportMeters()).rejects.toBeInstanceOf(PortalAuthError);
    expect(fake.calls.filter((p) => p === "/login")).toHaveLength(1);
  });

  it("follows DT pagination", async () => {
    fake.dts = [...fake.dts, ...fake.dts, ...fake.dts, ...fake.dts]; // 28 rows -> 2 pages
    expect(await fake.client().listTransformers()).toHaveLength(28);
  });

  it("refetches a rotated signing secret", async () => {
    const c = fake.client();
    await c.exportMeters();
    (c as any).signingSecret = "stale-secret";
    expect(await c.exportMeters()).toBeTruthy();
  });

  it("backs off for seconds on 429", async () => {
    const c = fake.client(undefined, sleeps);
    await c.listTransformers();
    fake.failNext = [{ status: 429, body: { error: "rate_limited" } }];
    expect(await c.listTransformers()).toBeTruthy();
    expect(sleeps[0]).toBeGreaterThanOrEqual(4000);
  });

  it("gives up with PortalUnavailable after repeated 5xx", async () => {
    const c = fake.client();
    await c.listTransformers();
    fake.failNext = Array(5).fill({ status: 503 });
    await expect(c.listTransformers()).rejects.toBeInstanceOf(PortalUnavailable);
  });

  it("retries transport errors", async () => {
    const c = fake.client();
    await c.listTransformers();
    fake.failNext = [timeout()];
    expect(await c.listTransformers()).toBeTruthy();
  });

  it("maps 404 to NotFoundError", async () => {
    await expect(fake.client().meterEnergy("NOPE")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats a non-JSON 200 as a protocol error", async () => {
    const c = fake.client();
    await c.listTransformers();
    fake.failNext = [{ status: 200, body: "<html>maintenance</html>" }];
    await expect(c.listTransformers()).rejects.toBeInstanceOf(PortalProtocolError);
  });
});
