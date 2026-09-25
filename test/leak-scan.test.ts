import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canary, encodingsOf, scanEnv, scanText, scanTexts, scanTree } from "./leak-scan.ts";

/**
 * The scanner's own positive control. Every "0 hits" elsewhere in the suite
 * leans on this: a scanner that cannot find a planted canary proves nothing
 * by finding nothing.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `suite-leakscan-01a0d8f8-${process.pid}-`));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("leak scan", () => {
  test("finds a canary planted in a nested file, a text, and an env map", () => {
    const secret = canary();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "config.json"), `{"token":"${secret}"}`);
    writeFileSync(join(dir, "clean.txt"), "nothing here");

    const fileHits = scanTree(dir, secret);
    expect(fileHits.map((h) => h.where)).toEqual([join(dir, "a", "b", "config.json")]);
    expect(scanTexts({ stdout: `x ${secret} y`, stderr: "clean" }, secret)).toEqual([
      { where: "stdout", encoding: "raw" },
    ]);
    expect(scanEnv("child", { A: "1", B: secret }, secret)).toEqual([{ where: "child:B", encoding: "raw" }]);
  });

  test("finds the base64 and URL-encoded spellings", () => {
    const secret = `${canary()}+/=`;
    const b64 = Buffer.from(secret).toString("base64");
    expect(scanText("t", `prefix ${b64}`, secret).map((h) => h.encoding)).toContain("base64");
    expect(scanText("t", encodeURIComponent(secret), secret).map((h) => h.encoding)).toContain("url");
  });

  test("an excluded (sanctioned) file is skipped, and only that file", () => {
    const secret = canary();
    const sanctioned = join(dir, "sanctioned.token");
    writeFileSync(sanctioned, secret);
    writeFileSync(join(dir, "leak.log"), secret);
    expect(scanTree(dir, secret, { exclude: [sanctioned] }).map((h) => h.where)).toEqual([join(dir, "leak.log")]);
  });

  test("a clean tree and text give zero hits, and a hit never carries the value", () => {
    const secret = canary();
    writeFileSync(join(dir, "clean.txt"), "nothing here");
    expect(scanTree(dir, secret)).toEqual([]);
    const hits = scanText("where", secret, secret);
    expect(JSON.stringify(hits)).not.toContain(secret);
  });

  test("refuses to scan for an empty secret, which would match everything", () => {
    expect(() => scanText("t", "x", "")).toThrow();
    expect(encodingsOf("abc").length).toBeGreaterThan(0);
  });
});
