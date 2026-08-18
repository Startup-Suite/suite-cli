import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The first `## x.y.z` heading in the changelog, or null if there is none. */
function topChangelogVersion(text: string): string | null {
  const m = text.match(/^## (\d+\.\d+\.\d+[^\s]*)$/m);
  return m === null ? null : m[1]!;
}

describe("version", () => {
  test("the changelog's newest entry is the version we ship", () => {
    /*
     * A bump is only useful if it is legible from the outside: someone with an
     * installed CLI compares `suite --version` against the changelog to answer
     * "is there anything new since mine?". A release that moves package.json and
     * forgets the entry, or writes an entry and forgets the bump, breaks that in
     * a way nothing else notices.
     */
    const top = topChangelogVersion(readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8"));
    expect(top).not.toBeNull(); // anti-vacuity: a parse that found nothing would "pass" below
    expect(top).toBe(VERSION);
  });

  test("the parser distinguishes a heading from prose that merely mentions a number", () => {
    // Without this, the check above could be satisfied by any text at all.
    expect(topChangelogVersion("we shipped 0.9.9 last week\n")).toBeNull();
    expect(topChangelogVersion("## 1.2.3\n")).toBe("1.2.3");
    expect(topChangelogVersion("## 1.2.3\n\n## 1.0.0\n")).toBe("1.2.3");
  });

  test("VERSION is the manifest's, not a second copy", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
