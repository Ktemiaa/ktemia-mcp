/**
 * Copies the shared tool spec next to the compiled output.
 *
 * `spec/tools.json` lives at the repo root so the Python package reads the
 * same file. npm cannot pack files outside the package directory, so the build
 * copies it in. Both servers therefore ship identical prose.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const source = join(repoRoot, "spec", "tools.json");
const target = join(here, "..", "dist", "tools.json");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.error(`sync-spec: ${source} -> ${target}`);
