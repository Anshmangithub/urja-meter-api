import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import swaggerUi from "swagger-ui-express";
import type { Gateway } from "./gateway.js";
import { NotFoundError, PortalAuthError, PortalProtocolError, PortalUnavailable } from "./errors.js";
import { buildOpenApi } from "./openapi.js";
import { buildRoutes, ValidationError } from "./routes.js";

export const VERSION = "0.1.0";
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

export function createApp(gw: Gateway, log: (msg: string) => void = () => undefined): Express {
  const app = express();
  app.disable("x-powered-by");

  const routes = buildRoutes(gw);
  const openapi = buildOpenApi(routes, VERSION);

  for (const r of routes) {
    const expressPath = r.path.replace(/\{(\w+)\}/g, ":$1");
    app[r.method](expressPath, async (req, res) => {
      let query: unknown = {};
      if (r.query) {
        const parsed = r.query.safeParse(req.query);
        if (!parsed.success) {
          throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        }
        query = parsed.data;
      }
      res.json(await r.handler({ query, params: req.params as Record<string, string>, res }));
    });
  }

  app.get("/openapi.json", (_req, res) => void res.json(openapi));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));
  app.use("/ui", express.static(WEB_DIR));
  app.get("/", (_req, res) => void res.redirect("/ui/"));

  app.use((_req, res) => void res.status(404).json({ error: "not_found", message: "No such route." }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const send = (status: number, error: string, message: string) => res.status(status).json({ error, message });
    if (err instanceof ValidationError) return send(422, "validation_error", err.message);
    if (err instanceof NotFoundError) return send(404, "not_found", `Not found: ${err.message}`);
    if (err instanceof PortalUnavailable) {
      res.setHeader("Retry-After", String(err.retryAfterS));
      return send(503, "portal_unavailable", err.message);
    }
    if (err instanceof PortalAuthError) {
      log(`portal login failed: ${err.message}`);
      return send(502, "portal_auth_failed", "The service could not sign in to the portal.");
    }
    if (err instanceof PortalProtocolError) {
      log(`portal protocol error: ${err.message}`);
      return send(502, "portal_protocol_error", "The portal returned an unexpected response.");
    }
    log(`unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return send(500, "internal_error", "Unexpected error.");
  };
  app.use(onError);
  return app;
}

export function openApiDocument(): Record<string, unknown> {
  return buildOpenApi(buildRoutes(undefined as unknown as Gateway), VERSION);
}
