/** Regenerate openapi.json from the application (no portal access or credentials needed). */
import { writeFileSync } from "node:fs";
import { openApiDocument } from "../src/app.js";

const out = new URL("../openapi.json", import.meta.url);
writeFileSync(out, JSON.stringify(openApiDocument(), null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
