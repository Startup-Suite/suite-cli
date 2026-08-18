import { describe, expect, test } from "bun:test";
import { CLAUDE_MD, claudeMdPlan } from "../src/claude_md.ts";

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
      expect(positive).toMatch(pattern);       // the pattern can fire...
      expect(CLAUDE_MD).not.toMatch(pattern);  // ...and does not, here
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
