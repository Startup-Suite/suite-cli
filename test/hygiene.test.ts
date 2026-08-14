import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * No deployment-specific access-proxy header may be named anywhere in this
 * repository — not as a default, not as a hint string, not as an example.
 *
 * Our own Suite instance happens to sit behind a particular access proxy and
 * needs a particular header pair. Another operator fronts theirs differently,
 * or not at all. Hardcoding ours would turn an accident of our infrastructure
 * into a property of the tool, and would quietly teach every reader that those
 * headers are what the CLI expects.
 *
 * The forbidden needles are assembled from fragments so that this test file
 * does not itself become the hit it is looking for.
 */
const NEEDLES = [["CF", "Access"].join("-"), ["cloud", "flare"].join("")];

const REPO = resolve(import.meta.dir, "..");

/** One neutral README sentence may say that header names are operator-specific. */
const README_ALLOWANCE = 1;

function trackedFiles(): string[] {
  // Cached AND untracked-but-not-ignored: a file added in this working tree and
  // not yet committed is exactly the one most likely to carry a paste.
  const p = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO,
    stdout: "pipe",
  });
  return new TextDecoder()
    .decode(p.stdout)
    .split("\0")
    .filter((f) => f !== "");
}

describe("no operator-specific access headers are hardcoded", () => {
  test("the tracked tree is free of them, case-insensitively", async () => {
    const files = trackedFiles();
    // Anti-vacuity: if the file list were empty this test would pass trivially.
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("src/secrets.ts");

    const hits: string[] = [];
    let readmeHits = 0;

    for (const file of files) {
      const text = await Bun.file(resolve(REPO, file)).text().catch(() => "");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? "").toLowerCase();
        if (!NEEDLES.some((n) => line.includes(n.toLowerCase()))) continue;
        if (file === "README.md") {
          readmeHits++;
          continue;
        }
        hits.push(`${file}:${i + 1}`);
      }
    }

    expect(hits).toEqual([]);
    expect(readmeHits).toBeLessThanOrEqual(README_ALLOWANCE);
  });

  test("the scan can actually find a hit, so a green result means something", async () => {
    const sample = `a line naming ${NEEDLES[0]}-Client-Id`.toLowerCase();
    expect(NEEDLES.some((n) => sample.includes(n.toLowerCase()))).toBe(true);
  });
});
