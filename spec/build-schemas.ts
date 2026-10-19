// SPDX-License-Identifier: Apache-2.0
// Writes schemas/*.json from src/schemas.ts. Run: npm run spec:schemas (a test checks they match).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_FILES } from "./src/schemas.ts";

for (const [name, schema] of Object.entries(SCHEMA_FILES)) writeFileSync(join(import.meta.dirname, "schemas", name), JSON.stringify(schema, null, 2) + "\n");
