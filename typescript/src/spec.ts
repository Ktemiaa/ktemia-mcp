/**
 * Loader for the shared tool contract in `spec/tools.json`.
 *
 * The same file is read by the Python server, so prose, enums, and defaults
 * cannot drift between the two packages. Validation schemas stay native: only
 * the shared contract comes from here.
 *
 * The file is copied next to the compiled output at build time (see
 * `scripts/sync-spec.mjs`) so it ships inside the published tarball.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface ParamSpec {
  description: string;
  enum?: string;
  default?: unknown;
  required?: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  params: Record<string, ParamSpec>;
}

interface Spec {
  specVersion: number;
  shared: Record<string, string>;
  enums: Record<string, string[]>;
  limits: Record<string, number>;
  tools: ToolSpec[];
}

function load(): Spec {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "tools.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      `Could not read the shared tool spec at ${path}. The build copies ` +
        `spec/tools.json next to the compiled output; run "npm run build". ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  const parsed = JSON.parse(raw) as Spec;
  if (parsed.specVersion !== 1) {
    throw new Error(
      `Unsupported tool spec version ${parsed.specVersion}; this build expects 1.`,
    );
  }
  return parsed;
}

const spec = load();

/** Every tool, in the order the spec lists them. */
export const TOOLS = spec.tools;

/**
 * Look up one tool by name.
 *
 * Throws rather than returning undefined: a typo here would silently register
 * a tool with no description, which is the exact drift this file exists to
 * prevent.
 */
export function tool(name: string): ToolSpec {
  const found = spec.tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(
      `No tool named "${name}" in spec/tools.json. Known tools: ${spec.tools
        .map((t) => t.name)
        .join(", ")}`,
    );
  }
  return found;
}

/** The description text for one parameter of one tool. */
export function param(toolName: string, paramName: string): string {
  const found = tool(toolName).params[paramName];
  if (!found) {
    throw new Error(
      `Tool "${toolName}" has no parameter "${paramName}" in spec/tools.json.`,
    );
  }
  return found.description;
}

/** A named enum's values, as a non-empty tuple for zod's `z.enum`. */
export function values(name: string): [string, ...string[]] {
  const found = spec.enums[name];
  if (!found || found.length === 0) {
    throw new Error(`No enum named "${name}" in spec/tools.json.`);
  }
  return found as [string, ...string[]];
}

/** A shared note, appended to tool descriptions that need it. */
export function note(name: keyof typeof spec.shared | string): string {
  const found = spec.shared[name];
  if (!found) {
    throw new Error(`No shared note named "${name}" in spec/tools.json.`);
  }
  return found;
}

/** A documented numeric limit, mirrored from the API's own configuration. */
export function limit(name: string): number {
  const found = spec.limits[name];
  if (found === undefined) {
    throw new Error(`No limit named "${name}" in spec/tools.json.`);
  }
  return found;
}

/**
 * Assembles a tool's full description: the spec prose plus whichever shared
 * notes apply. Keeping the joining logic here means both languages produce the
 * same final string from the same inputs.
 */
export function describe(name: string, notes: string[] = []): string {
  const parts = [tool(name).description, ...notes.map(note)];
  return parts.join(" ");
}
