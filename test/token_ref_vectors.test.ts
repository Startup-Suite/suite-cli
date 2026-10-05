/**
 * spec/token-ref-vectors.json, run against src/token_ref.ts.
 *
 * The vectors are the ONE definition of a token ref shared with both channel
 * plugins (which vendor this file, pinned to a suite-cli commit). suite-cli is
 * a REF-ONLY consumer: a literal is refused, never passed through.
 *
 * Every value is a fresh random canary, and every refusal message is scanned
 * for it: a refusal names refs, items, services, paths and modes, never a
 * value.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StampFailure } from "../src/stamp_result.ts";
import { SECURITY_BIN, parseTokenRef, resolveTokenRef, securityArgs } from "../src/token_ref.ts";
import { canary, scanText } from "./leak-scan.ts";

interface Vector {
  id: string;
  ref: string;
  keychain_service: string | null;
  platform: NodeJS.Platform;
  file?: { kind: "regular" | "symlink" | "absent"; mode?: string; owner?: "caller" | "other"; content?: string };
  security?: { exit: number; stdout: string } | null;
  expect: {
    outcome: "resolved" | "refused" | "literal";
    kind: string;
    value?: string;
    code?: string;
    names?: string[];
    security_args?: string[];
  };
}

const SPEC = JSON.parse(readFileSync(join(import.meta.dir, "..", "spec", "token-ref-vectors.json"), "utf8")) as {
  spec_version: number;
  security: { bin: string; args: string[] };
  vectors: Vector[];
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Outcome =
  | { outcome: "resolved"; value: string; calls: string[][] }
  | { outcome: "refused"; code: string; message: string; calls: string[][] };

/** Run one vector through parse + resolve, the way a suite-cli verb does. */
async function run(v: Vector, value: string): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), `suite-vectors-01a0d6b9-${process.pid}-`));
  dirs.push(dir);
  const fill = (s: string) => s.replaceAll("{dir}", dir).replaceAll("{value}", value);
  const tokenPath = join(dir, "runtime.token");
  if (v.file !== undefined && v.file.kind !== "absent") {
    const target = v.file.kind === "symlink" ? join(dir, "real.token") : tokenPath;
    writeFileSync(target, fill(v.file.content ?? ""));
    chmodSync(target, Number.parseInt(v.file.mode ?? "0600", 8));
    if (v.file.kind === "symlink") symlinkSync(target, tokenPath);
  }
  const me = process.getuid?.() ?? 0;
  const calls: string[][] = [];
  try {
    const ref = parseTokenRef(fill(v.ref), v.keychain_service === null ? {} : { keychainService: v.keychain_service });
    const resolved = await resolveTokenRef(ref, {
      platform: v.platform,
      uid: v.file?.owner === "other" ? me + 1 : me,
      exec: async (bin, args) => {
        calls.push([bin, ...args]);
        if (v.security === undefined || v.security === null) throw new Error(`vector ${v.id} did not expect security to run`);
        return { exitCode: v.security.exit, stdout: fill(v.security.stdout) };
      },
    });
    return { outcome: "resolved", value: resolved, calls };
  } catch (e) {
    if (!(e instanceof StampFailure)) throw e;
    return { outcome: "refused", code: e.code, message: e.message, calls };
  }
}

describe(`spec/token-ref-vectors.json v${SPEC.spec_version}`, () => {
  test("anti-vacuity: the file has vectors, and covers every outcome", () => {
    expect(SPEC.vectors.length).toBeGreaterThanOrEqual(20);
    const outcomes = new Set(SPEC.vectors.map((v) => v.expect.outcome));
    expect([...outcomes].sort()).toEqual(["literal", "refused", "resolved"]);
  });

  test("the resolver argv the spec pins is the one the code builds", () => {
    expect(SPEC.security.bin).toBe(SECURITY_BIN);
    expect(securityArgs({ service: "{service}", item: "{item}" })).toEqual(SPEC.security.args);
  });

  for (const v of SPEC.vectors) {
    test(`${v.id}: ${v.expect.outcome}${v.expect.code ? ` ${v.expect.code}` : ""}`, async () => {
      const value = canary("vec");
      const got = await run(v, value);
      const fillv = (s: string) => s.replaceAll("{value}", value);
      switch (v.expect.outcome) {
        case "resolved":
          expect(got.outcome).toBe("resolved");
          if (got.outcome === "resolved") expect(got.value).toBe(fillv(v.expect.value ?? ""));
          break;
        case "refused":
        case "literal":
          // suite-cli is a ref-only consumer: a literal is a refusal too.
          expect(got.outcome).toBe("refused");
          if (got.outcome === "refused") {
            expect(got.code).toBe(v.expect.code as string);
            for (const name of v.expect.names ?? []) expect(got.message).toContain(name);
            expect(scanText(v.id, got.message, value)).toEqual([]);
          }
          break;
        default:
          throw new Error(`unknown outcome ${String(v.expect.outcome)} in vector ${v.id}`);
      }
      if (v.expect.security_args !== undefined) {
        expect(got.calls).toEqual([[SPEC.security.bin, ...v.expect.security_args]]);
        // NAMES only: the value is never in the argv.
        expect(scanText("argv", got.calls.flat().join(" "), value)).toEqual([]);
      }
    });
  }
});
