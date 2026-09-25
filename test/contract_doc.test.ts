/**
 * The README's stamp-contract section names everything the contract emits.
 *
 * Callers (core's installer `setup channel` step first) read the README, not
 * src/stamp_result.ts. A field or exit code added to the code and not to the
 * section is an interface nobody was told about, so this test derives both
 * lists FROM THE CODE — what `renderStampResult` actually prints, and every
 * `EXIT_*` constant — and requires each to be named inside that one section.
 *
 * Scoped to the section on purpose: `ok` and `error` appear all over the
 * README, and a whole-file search would pass on the wrong sentence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as stampResult from "../src/stamp_result.ts";
import { EXIT_CODES, RESULT_FIELDS, emptyResult, renderStampResult } from "../src/stamp_result.ts";

const README = readFileSync(resolve(import.meta.dir, "..", "README.md"), "utf8");
const HEADING = "## Stamp contract (`--stamp-only`)";

/** The section from its heading to the next level-2 heading. */
export function contractSection(readme: string): string | null {
  const start = readme.indexOf(`\n${HEADING}\n`);
  if (start < 0) return null;
  const body = readme.slice(start + HEADING.length + 2);
  const next = body.search(/^## /m);
  return next < 0 ? body : body.slice(0, next);
}

/** The top-level fields the renderer really emits, in order. */
function emittedFields(): string[] {
  return Object.keys(JSON.parse(renderStampResult(emptyResult("hermes", 1))) as Record<string, unknown>);
}

/** Every exit code exported as an `EXIT_*` constant. */
function exportedExitCodes(): number[] {
  return Object.entries(stampResult)
    .filter(([name, value]) => /^EXIT_[A-Z]+$/.test(name) && typeof value === "number")
    .map(([, value]) => value as number)
    .sort();
}

/**
 * What the section fails to DEFINE: each field and each code must have its own
 * table row (`| \`name\` |` at the start of a line). A mere mention does not
 * count — `human_steps` is also named in the exit-code table, and a check that
 * accepted any mention stayed green with the field's own row deleted.
 */
export function missingFromSection(section: string, fields: readonly string[], codes: readonly number[]): string[] {
  const row = (name: string) => new RegExp(`^\\| \`${name}\` \\|`, "m");
  const missing: string[] = [];
  for (const f of fields) if (!row(f).test(section)) missing.push(`field ${f}`);
  for (const c of codes) if (!row(String(c)).test(section)) missing.push(`exit code ${c}`);
  return missing;
}

describe("the README stamp contract", () => {
  test("the section exists", () => {
    expect(contractSection(README)).not.toBeNull();
  });

  // The lists below are the code's, not a copy: if RESULT_FIELDS drifts from
  // what is printed, or EXIT_CODES from the constants, the doc check would be
  // checking the wrong list.
  test("RESULT_FIELDS is exactly what renderStampResult prints", () => {
    expect(emittedFields()).toEqual([...RESULT_FIELDS]);
  });

  test("EXIT_CODES covers every EXIT_* constant", () => {
    expect(exportedExitCodes()).toEqual([0, 1, 2, 3]);
    expect(Object.keys(EXIT_CODES).map(Number).sort()).toEqual(exportedExitCodes());
  });

  test("names every top-level field and every exit code", () => {
    const section = contractSection(README) ?? "";
    expect(missingFromSection(section, emittedFields(), exportedExitCodes())).toEqual([]);
  });

  test("states contract_version 1 and the additive-only rule", () => {
    const section = contractSection(README) ?? "";
    expect(section).toContain("contract_version: 1");
    expect(section).toMatch(/additive/i);
  });

  test("documents token-ref syntax, --keychain-service, idempotence and the intended caller", () => {
    const section = contractSection(README) ?? "";
    for (const needle of ["file:", "keychain:", "--keychain-service", "Idempotence", "setup\nchannel", "01a0d6b9"]) {
      expect(section.replace(/`/g, "")).toContain(needle.replace(/`/g, ""));
    }
  });

  /**
   * The check must be SHOWN to fire. Delete one field's and one exit code's
   * mention from a copy of the section and it must report exactly those.
   */
  test("positive control: removing a field or an exit code from the section is caught", () => {
    const section = contractSection(README) ?? "";
    const withoutField = section.replace(/^\| `harness_version` \|.*$/m, "");
    expect(missingFromSection(withoutField, emittedFields(), exportedExitCodes())).toEqual(["field harness_version"]);
    const withoutCode = section.replace(/^\| `3` \|.*$/m, "");
    expect(missingFromSection(withoutCode, emittedFields(), exportedExitCodes())).toEqual(["exit code 3"]);
  });
});
