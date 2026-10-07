/**
 * The README's status-contract section names every field `status --json` emits.
 *
 * The desktop app and any other caller read the README, not
 * src/commands/status.ts. So the field lists are derived FROM THE CODE — what
 * `renderStatusDocument` actually prints for a document with one agent row —
 * and each name must have its own table row inside that one section. Mirrors
 * test/contract_doc.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_FIELDS, STATUS_FIELDS, renderStatusDocument, statusDocument } from "../src/commands/status.ts";

const README = readFileSync(resolve(import.meta.dir, "..", "README.md"), "utf8");
const HEADING = "## Status contract (`status --json`)";

export function statusSection(readme: string): string | null {
  const start = readme.indexOf(`\n${HEADING}\n`);
  if (start < 0) return null;
  const body = readme.slice(start + HEADING.length + 2);
  const next = body.search(/^## /m);
  return next < 0 ? body : body.slice(0, next);
}

/** The top-level and agent-row fields the renderer really emits, in order. */
async function emitted(): Promise<{ top: string[]; agent: string[] }> {
  const doc = await statusDocument({
    source: {
      records: [{ record: { dir: "/fixture/a", suiteUrl: "https://one.example.invalid", runtimeId: "rt-a", headerNames: [] }, path: "/p" }],
      roster: [],
      claudeJson: { projects: {}, userScope: [] },
      sessionNaming: "cwd",
      readFile: () => null,
    },
    connection: null,
    legacy: null,
    detect: async () => "none",
  });
  const parsed = JSON.parse(renderStatusDocument(doc)) as Record<string, unknown>;
  const row = (parsed.agents as Record<string, unknown>[])[0] ?? {};
  return { top: Object.keys(parsed), agent: Object.keys(row) };
}

export function missingFromSection(section: string, fields: readonly string[]): string[] {
  const row = (name: string) => new RegExp(`^\\| \`${name}\` \\|`, "m");
  return fields.filter((f) => !row(f).test(section)).map((f) => `field ${f}`);
}

describe("the README status contract", () => {
  test("the section exists", () => {
    expect(statusSection(README)).not.toBeNull();
  });

  test("STATUS_FIELDS and AGENT_FIELDS are exactly what renderStatusDocument prints", async () => {
    const { top, agent } = await emitted();
    expect(top).toEqual([...STATUS_FIELDS]);
    expect(agent).toEqual([...AGENT_FIELDS]);
  });

  test("names every top-level and every agent field in its own table row", async () => {
    const { top, agent } = await emitted();
    expect(missingFromSection(statusSection(README) ?? "", [...top, ...agent])).toEqual([]);
  });

  test("states contract_version 1 and the additive-only rule", () => {
    const section = statusSection(README) ?? "";
    expect(section).toContain("contract_version: 1");
    expect(section).toMatch(/additive/i);
  });

  test("positive control: removing a field's row from the section is caught", async () => {
    const { top, agent } = await emitted();
    const section = statusSection(README) ?? "";
    expect(missingFromSection(section.replace(/^\| `wiring` \|.*$/m, ""), [...top, ...agent])).toEqual(["field wiring"]);
    expect(missingFromSection(section.replace(/^\| `legacy_connection` \|.*$/m, ""), [...top, ...agent])).toEqual([
      "field legacy_connection",
    ]);
  });
});
