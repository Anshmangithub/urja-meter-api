import "dotenv/config";
import { createApp } from "./app.js";
import { loadSettings } from "./config.js";
import { Gateway } from "./gateway.js";
import { PortalClient } from "./portal.js";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const settings = loadSettings();
const portal = new PortalClient(settings, { log });
const gateway = new Gateway(settings, portal);
const app = createApp(gateway, log);

app.listen(settings.port, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${settings.port}  (docs: /docs, ui: /ui/)`);
  // Warm the snapshot without blocking startup; the first real request retries and reports properly.
  gateway.snapshot().then(
    (s) => log(`snapshot loaded: ${s.meters.size} meters, ${s.transformers.size} DTs`),
    (e: Error) => log(`startup snapshot failed: ${e.message}`),
  );
});
