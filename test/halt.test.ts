import { describe, expect, test } from "bun:test";
import {
  ASK_SCAN_BYTES,
  HALT_MARKERS,
  TAIL_BYTES,
  buildReorientation,
  claudeRoot,
  contextTokens,
  conversationMb,
  detectHalt,
  planRecovery,
  promptLanded,
  projectSlug,
  projectSlugResolved,
  resolveTmux,
  sendEnterArgv,
  sendLiteralArgv,
  telemetryRequest,
  transcriptDir,
} from "../src/halt.ts";

/**
 * Records copied from real transcripts on a box that hit both walls, trimmed
 * only at the ends. Do not paraphrase them: the whole detector is an exact
 * match against this shape.
 */
const REAL_CONTEXT_HALT =
  '{"type":"assistant","message":{"usage":{"input_tokens":4,"cache_creation_input_tokens":0,"cache_read_input_tokens":198450},"content":[{"type":"text","text":"Prompt is too long"}]},"requestId":"req_011CebVxdq8N"}';

const REAL_REQUEST_HALT =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Request too large for the API\'s 32MB request limit: this conversation is about 37.3MB, and none of it is images or documents that could be removed, so removing attachments or compacting cannot make it fit."}]},"requestId":"req_011Cxyz"}';

const REAL_JOINED_HALT =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Prompt is too long \u00b7 automatic compaction failed: Request too large for the API\'s 32MB request limit: this conversation is about 46.9MB, and none of it is images or documents that could be removed, so removing attachments or compacting cannot make it fit. Double press esc to go back past the large content, or /clear to start a new conversation."}]},"requestId":"req_011Cjoin"}';

describe("halt detection", () => {
  test("finds the context-window wall in a real record", () => {
    expect(detectHalt(REAL_CONTEXT_HALT)).toBe("context_window");
  });

  test("finds the request-size wall in a real record", () => {
    expect(detectHalt(REAL_REQUEST_HALT)).toBe("request_size");
  });

  /**
   * The shape that was actually on a wedged host, and that neither marker
   * matched: both walls in ONE message, because compaction was attempted and
   * failed. The watcher called that session healthy for eleven hours.
   */
  test("finds the joined wall Claude Code emits when compaction fails", () => {
    expect(detectHalt(REAL_JOINED_HALT)).toBe("request_size");
  });

  test("the joined wall still yields the size the API measured", () => {
    expect(conversationMb(REAL_JOINED_HALT)).toBe(46.9);
  });

  /**
   * A later record mentioning the ceiling must not reclassify an earlier
   * context-window halt: the scan is bounded to the matched record.
   */
  test("does not borrow a request-size phrase from a following record", () => {
    const tail =
      REAL_CONTEXT_HALT +
      '\n{"type":"assistant","message":{"content":[{"type":"text","text":"We hit Request too large for the API\'s 32MB request limit last week."}]}}';
    expect(detectHalt(tail)).toBe("context_window");
  });

  test("healthy transcript tail detects nothing", () => {
    expect(detectHalt('{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}')).toBeNull();
  });

  /**
   * THE property this detector exists to have.
   *
   * An agent writing about the error — a ticket, a channel message, this very
   * comment — stores it nested inside a JSON string, so every quote arrives
   * backslash-escaped. A substring match fires on that and reports a healthy
   * session as halted; it did exactly that to the session authoring the
   * feature. The anchored unescaped form cannot.
   */
  test("does NOT fire on an agent quoting the error in prose", () => {
    const discussing =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"The halt record is \\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Prompt is too long\\"}] and we match it anchored."}]}}';
    expect(discussing).toContain("Prompt is too long");
    expect(detectHalt(discussing)).toBeNull();
  });

  test("does NOT fire on an agent quoting the JOINED error in prose", () => {
    const discussing =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"It said \\"Prompt is too long \u00b7 automatic compaction failed: Request too large for the API\'s 32MB request limit\\" and stopped."}]}}';
    expect(detectHalt(discussing)).toBeNull();
  });

  test("markers stay anchored at the content boundary", () => {
    for (const { marker } of HALT_MARKERS) {
      expect(marker.startsWith('"content":[{"type":"text","text":"')).toBe(true);
    }
  });
});

describe("what the API told us", () => {
  test("reads back the conversation size the API measured", () => {
    expect(conversationMb(REAL_REQUEST_HALT)).toBe(37.3);
  });

  test("context-window halts carry no size, and that is not an error", () => {
    expect(conversationMb(REAL_CONTEXT_HALT)).toBeNull();
  });
});

describe("context occupancy", () => {
  /**
   * The three fields are disjoint parts of one prompt. Reading input_tokens
   * alone reports 4 for a turn actually carrying ~198k, which would place a
   * nearly-full session at the bottom of any threshold.
   */
  test("sums fresh, cached and cache-read rather than trusting input_tokens", () => {
    expect(contextTokens(REAL_CONTEXT_HALT)).toBe(198454);
  });

  test("absent usage yields null, not zero", () => {
    expect(contextTokens('{"type":"user"}')).toBeNull();
  });
});

describe("project slug", () => {
  test("matches directories observed on disk", () => {
    expect(projectSlug("/home/queen/agents/dalton")).toBe("-home-queen-agents-dalton");
    expect(projectSlug("/home/queen/sources/ai-gateway")).toBe("-home-queen-sources-ai-gateway");
  });

  test("a dot contributes its own dash, as .openclaw shows", () => {
    expect(projectSlug("/home/queen/.openclaw")).toBe("-home-queen--openclaw");
  });

  test("transcriptDir composes under the home directory", () => {
    expect(transcriptDir("/home/q", "/a/b")).toBe("/home/q/.claude/projects/-a-b");
  });
});

describe("recovery gate", () => {
  /**
   * Typing /clear into a pane whose agent has exited does not clear anything —
   * the shell runs it. Only "live" may be acted on.
   */
  test("refuses to send keys to a stale pane even with a real halt", () => {
    const plan = planRecovery("stale", "context_window");
    expect(plan.action).toBe("none");
    if (plan.action === "none") expect(plan.reason).toContain("stale");
  });

  test("refuses when no session exists", () => {
    expect(planRecovery("none", "request_size").action).toBe("none");
  });

  test("does nothing on a live but healthy session", () => {
    expect(planRecovery("live", null).action).toBe("none");
  });

  test("recovers a live halted session", () => {
    expect(planRecovery("live", "request_size")).toEqual({ action: "recover", kind: "request_size" });
  });
});

describe("key sending", () => {
  test("literal text is sent with -l so tmux does not read it as key names", () => {
    expect(sendLiteralArgv("suite-x", "/clear")).toEqual(["tmux", "send-keys", "-t", "suite-x", "-l", "/clear"]);
  });

  test("Enter is a separate call, since -l would type the word", () => {
    expect(sendEnterArgv("suite-x")).toEqual(["tmux", "send-keys", "-t", "suite-x", "Enter"]);
    expect(sendEnterArgv("suite-x")).not.toContain("-l");
  });
});

describe("telemetry", () => {
  const sink = { endpoint: "http://obs.invalid:5080/", org: "default", stream: "claude_session_halts" };

  test("posts a JSON array; NDJSON is rejected by the ingest endpoint", () => {
    const req = telemetryRequest(sink, []);
    expect(req.url).toBe("http://obs.invalid:5080/api/default/claude_session_halts/_json");
    expect(JSON.parse(req.body)).toEqual([]);
  });

  test("trailing slash on the endpoint does not double up", () => {
    expect(telemetryRequest(sink, []).url).not.toContain("//api");
  });
});

describe("reorientation prompt", () => {
  const built = buildReorientation({
    cwd: "/home/queen/agents/dalton",
    sessionId: "abc",
    haltKind: "request_size",
    contextTokens: 198454,
    recentAsks: ["is this still underway?", "modify the suite cli"],
    suiteFacts: ["task 01a0 — stage 2 running"],
  });

  test("names the wall that was hit", () => {
    expect(built).toContain("32MB");
  });

  test("carries reconstructed facts rather than asking the model to recall", () => {
    expect(built).toContain("/home/queen/agents/dalton");
    expect(built).toContain("is this still underway?");
    expect(built).toContain("task 01a0 — stage 2 running");
    expect(built.toLowerCase()).not.toContain("remember");
  });

  test("omits the Suite section entirely when no facts were supplied", () => {
    const bare = buildReorientation({
      cwd: "/x", sessionId: "a", haltKind: "context_window", contextTokens: null, recentAsks: [],
    });
    expect(bare).not.toContain("Open work");
  });
});

describe("symlinked working directories", () => {
  /**
   * Observed on a real macOS agent host: the agent runs from ~/Dev/agents/x
   * where ~/Dev is a symlink to /Volumes/Dev, and Claude Code writes to
   * -Volumes-Dev-agents-x. Slugging the unresolved path yields a directory
   * that does not exist — and a missing directory reads as "healthy", which is
   * the dangerous direction to be wrong in.
   */
  test("slugs the resolved path, not the symlink", () => {
    const realpath = (p: string) => p.replace("/Users/rock/Dev", "/Volumes/Dev");
    expect(projectSlugResolved("/Users/rock/Dev/agents/brosnan", realpath)).toBe(
      "-Volumes-Dev-agents-brosnan",
    );
  });

  test("an unresolvable path falls back rather than throwing", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(projectSlugResolved("/gone/x", boom)).toBe("-gone-x");
  });
});

describe("locating tmux", () => {
  /**
   * A watcher started by launchd, cron or a non-interactive ssh gets a minimal
   * PATH with no Homebrew in it. Spawning bare `tmux` there fails for every
   * session at once, and the sweep reports that as "no sessions" — i.e. as
   * health. This was not theorised: a non-interactive ssh reported a host as
   * having no sessions while it was running two.
   */
  test("prefers the resolved absolute path", () => {
    expect(resolveTmux(() => "/opt/homebrew/bin/tmux")).toBe("/opt/homebrew/bin/tmux");
  });

  /**
   * The fallback is the BARE NAME, deliberately, and this test replaces one
   * that asserted the opposite. A guessed absolute path is a guaranteed ENOENT
   * on any machine that puts tmux somewhere else — which is how the earlier
   * version failed, guessing a macOS Homebrew path on a Linux host whose tmux
   * was under Linuxbrew. A bare name at least lets spawn search PATH.
   */
  test("falls back to the bare name so spawn can still search PATH", () => {
    expect(resolveTmux(() => null)).toBe("tmux");
  });
});

describe("ask-scan window", () => {
  /**
   * The two windows look for different things and must not share a size. A
   * halt is the last record, so 64KB always holds it. An ask can sit anywhere:
   * measured on a real 87KB transcript whose only ask was at byte 941 — 86KB
   * from the end, invisible to the halt window, producing a reorientation with
   * no asks in it at all.
   */
  test("is much larger than the halt window", () => {
    expect(ASK_SCAN_BYTES).toBeGreaterThan(TAIL_BYTES * 8);
  });

  test("stays bounded — these transcripts reach gigabytes", () => {
    expect(ASK_SCAN_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("relocated Claude state", () => {
  /**
   * The gap that mattered most, because of its direction. Assuming ~/.claude
   * on a host with CLAUDE_CONFIG_DIR set means no transcripts are found, every
   * session is skipped, and the sweep reports a clean box — silence that looks
   * exactly like health.
   */
  test("CLAUDE_CONFIG_DIR wins over the default", () => {
    expect(claudeRoot("/home/q", { CLAUDE_CONFIG_DIR: "/mnt/state/claude" })).toBe(
      "/mnt/state/claude",
    );
  });

  test("falls back to ~/.claude when unset or empty", () => {
    expect(claudeRoot("/home/q", {})).toBe("/home/q/.claude");
    expect(claudeRoot("/home/q", { CLAUDE_CONFIG_DIR: "" })).toBe("/home/q/.claude");
  });

  test("transcriptDir composes under the override, not the home dir", () => {
    expect(transcriptDir("/home/q", "/a/b", { CLAUDE_CONFIG_DIR: "/state" })).toBe(
      "/state/projects/-a-b",
    );
  });

  test("and under home when there is no override", () => {
    expect(transcriptDir("/home/q", "/a/b")).toBe("/home/q/.claude/projects/-a-b");
  });
});

describe("checking that a reorientation actually landed", () => {
  const PROMPT =
    "Your context was cleared automatically after the session hit the API's 32MB request limit.\n\nWorking directory: /w\n\nRe-read any file.";

  test("sees the opening line in a pane that hard-wrapped it", () => {
    const pane =
      "\u276f Your context was cleared automatically after the session hit the API's\n  32MB request limit.\n\n  Working directory: /w";
    expect(promptLanded(pane, PROMPT)).toBe(true);
  });

  /**
   * The observed truncation: only the tail arrived. Matching on any part of the
   * prompt would call this landed — the opening is checked precisely because
   * the opening is the part that goes missing.
   */
  test("rejects a pane holding only the tail of the prompt", () => {
    expect(promptLanded("\u276f Re-read any file.", PROMPT)).toBe(false);
  });

  test("an empty prompt is vacuously landed rather than an infinite retry", () => {
    expect(promptLanded("", "")).toBe(true);
  });
});
