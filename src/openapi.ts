/** Generates the OpenAPI 3.1 document from the route table and the zod models. */
import { z } from "zod";
import { ProblemSchema } from "./models.js";
import type { Route } from "./routes.js";

type Json = Record<string, any>;

const DESCRIPTION = `A clean, read-only REST API over the legacy **Urja Meter Ops** portal.

* Fleet data (meters, network hierarchy, transformers) is served from a local snapshot built from the portal's bulk export and refreshed in the background. Responses carry \`X-Snapshot-Age\` (seconds). If the portal is down, the last good snapshot keeps being served.
* Consumption is fetched live from the portal per meter and cached briefly.
* Known data problems in the portal are repaired where safe, flagged per meter in \`quality_flags\`, and listed at \`GET /data-quality\`.

All JSON is snake_case; enums are lower-case slugs; timestamps are ISO-8601 with offset. Errors are always \`{"error","message"}\`.`;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Point refs at components.schemas and drop the MAX_SAFE_INTEGER bounds zod adds to every integer. */
function tidy(node: unknown): any {
  if (Array.isArray(node)) return node.map(tidy);
  if (node === null || typeof node !== "object") return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if ((key === "minimum" && value === -MAX_SAFE) || (key === "maximum" && value === MAX_SAFE)) continue;
    out[key] = key === "$ref" && typeof value === "string" ? value.replace("#/$defs/", "#/components/schemas/") : tidy(value);
  }
  return out;
}

export function buildOpenApi(routes: Route[], version: string): Json {
  const components: Record<string, Json> = {};

  /** zod -> JSON Schema, hoisting named definitions into components.schemas. */
  const schemaOf = (schema: z.ZodType, io: "input" | "output" = "output"): Json => {
    const js = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Json;
    const defs = js.$defs ?? {};
    delete js.$defs;
    delete js.$schema;
    Object.assign(components, tidy(defs));
    return tidy(js);
  };

  const problem = (description: string): Json => ({
    description,
    content: { "application/json": { schema: schemaOf(ProblemSchema) } },
  });

  const paths: Json = {};
  for (const r of routes) {
    const parameters: Json[] = [];
    for (const [, name] of r.path.matchAll(/\{(\w+)\}/g)) {
      parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
    }
    for (const [name, field] of Object.entries(r.query?.shape ?? {})) {
      const js = schemaOf(field as z.ZodType);
      const { description, ...schema } = js;
      parameters.push({
        name,
        in: "query",
        required: !(field as z.ZodType).safeParse(undefined).success,
        ...(description ? { description } : {}),
        schema,
      });
    }
    const responses: Json = {
      "200": { description: "OK", content: { "application/json": { schema: schemaOf(r.response) } } },
      "422": problem("Invalid parameters"),
      "502": problem("The portal behaved unexpectedly or rejected our login"),
      "503": problem("The portal is unavailable; see Retry-After"),
    };
    if (r.notFound) responses["404"] = problem("Not found");
    (paths[r.path] ??= {})[r.method] = {
      summary: r.summary,
      tags: [r.tag],
      operationId: `${r.method}_${r.path.replace(/[{}]/g, "").replace(/\W+/g, "_").replace(/^_|_$/g, "")}`,
      ...(parameters.length ? { parameters } : {}),
      responses,
    };
  }

  components.Problem ??= schemaOf(ProblemSchema);
  const sortedSchemas = Object.fromEntries(Object.entries(components).sort(([a], [b]) => a.localeCompare(b)));
  return {
    openapi: "3.1.0",
    info: { title: "Urja Meter API", version, description: DESCRIPTION },
    paths,
    components: { schemas: sortedSchemas },
  };
}
