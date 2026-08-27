import { describe, expect, test } from "bun:test";
import {
  CLAUDE_MD,
  CONVENTIONS_FILENAME,
  CONVENTIONS_MD,
  CONVENTION_MARKERS,
  SUITE_CONVENTIONS,
  claudeMdPlan,
  conventionsAdvice,
  conventionsPlan,
  missingConventions,
} from "../src/claude_md.ts";

describe("the starting CLAUDE.md", () => {
  test("an existing file is NEVER overwritten", () => {
    /*
     * The rule the whole module exists for. Asserted on the plan rather than by
     * staging a real file and trusting it survived, so a regression shows up as
     * a failing decision instead of as a user's lost notes.
     */
    expect(claudeMdPlan("/agents/ada/CLAUDE.md", true)).toEqual({
      path: "/agents/ada/CLAUDE.md",
      action: "skip",
    });
  });

  test("a missing file is written", () => {
    expect(claudeMdPlan("/agents/ada/CLAUDE.md", false).action).toBe("write");
  });

  test("carries no identifiers — it lands in a directory that may be a repo", () => {
    /*
     * One case per side would be vacuous here: the template is static, so a
     * pattern that never matches proves nothing about the check. Each pattern
     * is therefore proven live against a string that DOES contain the thing.
     */
    const forbidden: Array<[RegExp, string]> = [
      [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/, "id 123e4567-e89b-12d3-a456-426614174000"],
      [/https?:\/\/(?!github\.com)[^\s`)]+/, "see https://internal.example.invalid/x"],
      [/\bBearer\s+\S+/, "Authorization: Bearer abc123"],
      [/\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b/, "connect to 10.0.0.1 first"],
    ];
    for (const [pattern, positive] of forbidden) {
      expect(positive).toMatch(pattern);           // the pattern can fire...
      expect(CLAUDE_MD).not.toMatch(pattern);      // ...and does not, here
      expect(CONVENTIONS_MD).not.toMatch(pattern); // ...nor in the owned file
    }
  });

  test("states the conventions an agent cannot infer", () => {
    // Not a spell-check of the prose: each of these is a rule a new agent gets
    // wrong by default, so losing one silently is the regression that matters.
    expect(CLAUDE_MD).toContain("assignment IS the authorization");
    expect(CLAUDE_MD).toContain("suite_reply");
    expect(CLAUDE_MD).toContain("Never self-approve a human gate");
    expect(CLAUDE_MD).toContain("memory_");
  });

  test("tells the reader the file is theirs and safe from re-runs", () => {
    expect(CLAUDE_MD).toContain("never overwrite it");
  });
});

describe("delivering the conventions when CLAUDE.md is someone else's file", () => {
  const OWNED = "/repo/SUITE_CONVENTIONS.md";

  /**
   * THE DEFECT. `exists ? skip : write` cannot tell an agent's brief from a
   * project's codebase guide, so in every repo that ships its own CLAUDE.md the
   * agent received nothing and nothing said so. Asserted on the plan, so the
   * fix is a decision that can be read rather than a tree that has to be
   * inspected afterwards.
   */
  test("an existing CLAUDE.md that states none of them still gets them", () => {
    const theirs = "# my-project\n\nRun `make test`. Prefer small commits.\n";

    const plan = conventionsPlan(OWNED, theirs);

    expect(plan).toEqual({
      path: OWNED,
      action: "write",
      claudeMd: "unlinked",
      missing: CONVENTION_MARKERS.map((c) => c.name),
    });
    // ...and the operator is told, by name, what their file is missing.
    expect(conventionsAdvice(plan).join("\n")).toContain("assignment is already the authorization");
    expect(conventionsAdvice(plan).join("\n")).toContain(`@${CONVENTIONS_FILENAME}`);
  });

  /**
   * THE CONTROL, and the half that matters most: the test above alone passes an
   * implementation that writes unconditionally, which would put a redundant
   * file into every repo on every run.
   */
  test("a CLAUDE.md that already states them is left to it — nothing duplicated", () => {
    expect(conventionsPlan(OWNED, CLAUDE_MD)).toEqual({
      path: OWNED,
      action: "skip",
      claudeMd: "carries",
      missing: [],
    });
    expect(conventionsAdvice(conventionsPlan(OWNED, CLAUDE_MD))).toEqual([]);
  });

  test("a CLAUDE.md that loads the owned file gets it refreshed, not nagged about", () => {
    const plan = conventionsPlan(OWNED, `# my-project\n\n@${CONVENTIONS_FILENAME}\n`);
    expect(plan.action).toBe("write");
    expect(plan.claudeMd).toBe("linked");
    expect(conventionsAdvice(plan)).toEqual([]);
  });

  test("no CLAUDE.md at all needs no second file — the seeded one carries them", () => {
    const plan = conventionsPlan(OWNED, null);
    expect(plan.action).toBe("skip");
    expect(plan.claudeMd).toBe("seeded");
  });

  /*
   * A marker that can never match would report every file as missing
   * everything, and a marker that always matches would report every file as
   * complete. Both directions are proven, or the detector is decoration.
   */
  test("every marker hits the real conventions and misses a file without them", () => {
    expect(CONVENTION_MARKERS.length).toBeGreaterThan(0);
    for (const { marker } of CONVENTION_MARKERS) {
      expect(SUITE_CONVENTIONS).toContain(marker);
    }
    expect(missingConventions(SUITE_CONVENTIONS)).toEqual([]);
    expect(missingConventions("# nothing to do with Suite\n")).toEqual(
      CONVENTION_MARKERS.map((c) => c.name),
    );
  });

  test("the owned file carries the conventions and says it is rewritten", () => {
    expect(CONVENTIONS_MD).toContain("assignment IS the authorization");
    expect(CONVENTIONS_MD).toContain("Never self-approve a human gate");
    // It is not a place to keep notes, and it says so where they would be lost.
    expect(CONVENTIONS_MD).toContain("rewrites it on every run");
    expect(CONVENTIONS_MD).toContain(`@${CONVENTIONS_FILENAME}`);
  });

  test("the seeded CLAUDE.md and the owned file state the same conventions", () => {
    // One source. Two copies of this prose would drift, and the copy that
    // drifts is the one an agent reads.
    expect(CLAUDE_MD).toContain(SUITE_CONVENTIONS);
    expect(CONVENTIONS_MD).toContain(SUITE_CONVENTIONS);
  });
});
