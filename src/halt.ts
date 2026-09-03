/**
 * Detecting a halted Claude Code session, and recovering it in place.
 *
 * A Claude Code session can stop dead in a way `tmux has-session` and even a
 * running-process check both call healthy: the TUI is up, the process is alive,
 * and every further turn fails. Two distinct walls produce it, and BOTH are
 * recorded verbatim in the session transcript:
 *
 *   1. the context window   -> "Prompt is too long"
 *   2. the API request size -> "Request too large for the API's 32MB request
 *      limit: this conversation is about 37.3MB, and none of it is images or
 *      documents that could be removed, so removing attachments or compacting
 *      cannot make it fit."
 *
 * The second message is worth reading closely: the 32MB ceiling is on the
 * REQUEST, not on the transcript file, and it states outright that compaction
 * cannot rescue it. So "we hit 32MB" and "compaction stopped working" are one
 * wall, not two. Measuring the `.jsonl` size instead is measuring the wrong
 * quantity — that file accumulates every turn ever written, and observed
 * healthy sessions reach 88MB and 943MB.
 *
 * WHY WE MATCH THE RECORD SHAPE AND NOT THE STRING. A genuine halt is an
 * assistant message whose entire content is the error, so the transcript holds
 * UNESCAPED JSON structure. An agent that merely *writes about* the error —
 * filing the ticket, explaining it in chat — has that text nested inside a
 * string, where the quotes arrive backslash-escaped. Matching the unescaped
 * anchored form is therefore structurally unable to fire on discussion of
 * itself. This is not hypothetical: a substring grep flagged the live session
 * that was authoring this feature.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not predict the wall.
 * The obvious predictor — bytes accumulated since the last
 * `{"subtype":"compact_boundary"}` marker — was measured against a real halt
 * and read 10.6MB where the API itself reported 37.3MB. That is 3.5x low, in
 * the direction that yields a watcher which never fires. Detection here is
 * exact and after-the-fact; prediction needs a ratio fitted from collected
 * halts, which is what the telemetry is for.
 */

/** Which wall a session hit. */
export type HaltKind = "context_window" | "request_size";

/**
 * Anchored markers, longest-lived contract in this file.
 *
 * Each begins at the `"content":[{...}]` boundary so the match can only land on
 * a real assistant record. Do not "simplify" these to the bare sentence.
 */
export const HALT_MARKERS: ReadonlyArray<{ kind: HaltKind; marker: string }> = [
  {
    kind: "context_window",
    marker: '"content":[{"type":"text","text":"Prompt is too long"}]',
  },
  {
    kind: "request_size",
    marker:
      '"content":[{"type":"text","text":"Request too large for the API\'s 32MB request limit',
  },
];

/** Bytes of transcript tail to inspect. A halt is always terminal. */
export const TAIL_BYTES = 65536;

/**
 * Bytes to scan when reconstructing what the user actually asked.
 *
 * Deliberately much larger than TAIL_BYTES, because the two are looking for
 * different things. A halt is the LAST record, so 64KB always contains it. A
 * user's ask can sit anywhere: one turn that produced a lot of tool output
 * pushes it far back. Measured on a real session — an 87KB transcript whose
 * single ask was at byte 941, i.e. 86KB from the end and invisible to the
 * 64KB window, which produced a reorientation with no asks in it at all.
 *
 * Still bounded rather than whole-file: these transcripts reach 1.3GB.
 */
export const ASK_SCAN_BYTES = 2 * 1024 * 1024;

/** The kind of halt present in a transcript tail, or null if healthy. */
export function detectHalt(tail: string): HaltKind | null {
  for (const { kind, marker } of HALT_MARKERS) {
    if (tail.includes(marker)) return kind;
  }
  return null;
}

/**
 * The conversation size the API itself reported, in MB.
 *
 * Only the request-size wall carries this. It is the single most useful number
 * for calibrating a future predictor, because it is measured by the thing doing
 * the rejecting rather than inferred by us.
 */
export function conversationMb(tail: string): number | null {
  const m = tail.match(/this conversation is about ([0-9.]+)MB/);
  return m ? Number(m[1]) : null;
}

/**
 * Claude Code's on-disk project directory name for a working directory.
 *
 * Derived by observation: every non-alphanumeric character becomes `-`, which
 * is why `/home/queen/.openclaw` lands at `-home-queen--openclaw` (the slash
 * and the dot each contribute one). Hyphens already present survive, and case
 * is preserved. Underscore handling follows the same rule but has not been
 * observed directly — flagged rather than asserted.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Map a directory to its slug the way Claude Code does — after resolving
 * symlinks.
 *
 * On a box where the agent runs from `~/Dev/agents/x` and `~/Dev` is a symlink
 * to `/Volumes/Dev`, Claude Code writes to `-Volumes-Dev-agents-x`. Slugging
 * the unresolved path yields `-Users-...-Dev-agents-x`, which does not exist,
 * and the lookup fails in the direction that looks like "this session is fine".
 * Observed on a real macOS agent host.
 */
export function projectSlugResolved(cwd: string, realpath: (p: string) => string): string {
  let resolved = cwd;
  try {
    resolved = realpath(cwd);
  } catch {
    /* path gone; slug what we were given */
  }
  return projectSlug(resolved);
}

/**
 * Root of Claude Code's own state, honouring CLAUDE_CONFIG_DIR.
 *
 * Assuming `~/.claude` is the failure that matters most here, because of the
 * DIRECTION it fails in: a relocated config dir means no transcripts are found,
 * every session is skipped, and the sweep reports a clean box. Silence that
 * looks like health is the exact thing this watchdog exists to eliminate, so it
 * must not be built on a guess about where state lives.
 */
export function claudeRoot(home: string, env: Record<string, string | undefined> = {}): string {
  const override = env.CLAUDE_CONFIG_DIR;
  return override && override !== "" ? override : `${home}/.claude`;
}

/** Absolute path of the transcript directory for a working directory. */
export function transcriptDir(
  home: string,
  cwd: string,
  env: Record<string, string | undefined> = {},
): string {
  return `${claudeRoot(home, env)}/projects/${projectSlug(cwd)}`;
}

/**
 * One observation, shaped for telemetry.
 *
 * Two kinds, and the second is not padding. `context_tokens` is ALWAYS null on
 * a halt: the rejected request reports zero usage, and the session never runs
 * another successful turn afterwards, so there is no occupancy figure to
 * recover — verified by finding no non-zero usage in the last 4MB of two real
 * halted transcripts. Occupancy can therefore only be collected from HEALTHY
 * sessions, which is exactly the series a future predictor has to be fitted
 * against. Sampling the living is how we learn to anticipate the dead.
 */
export interface HaltEvent {
  host: string;
  session: string;
  project: string;
  session_id: string;
  event_kind: "halt" | "sample";
  halt_kind: HaltKind | null;
  conversation_mb: number | null;
  file_bytes: number;
  context_tokens: number | null;
  /**
   * Resident memory of the session's whole process tree, bytes.
   *
   * Harness-agnostic, unlike context_tokens: an agent with no Claude Code
   * transcript still has RSS. This is the only figure recorded here that
   * covers every agent on a box.
   */
  rss_bytes?: number | null;
  recovered: boolean;
  event_time: string;
  source: "suite_cli_halt_watch";
}

/**
 * Context occupancy at the last recorded turn.
 *
 * The three fields sum because they are disjoint parts of one prompt: freshly
 * sent, newly cached, and read from cache. Any one alone understates it badly —
 * `input_tokens` in particular reads as single digits on a cached turn.
 */
export function contextTokens(tail: string): number | null {
  // Two traps, both found by running this against genuinely halted transcripts
  // rather than against a fixture:
  //
  // 1. A real `usage` object contains NESTED objects (cache_creation,
  //    output_tokens_details), so a `[^}]*` span stops at the first inner brace
  //    and loses the fields that matter. Brace-balance instead.
  // 2. THE LAST usage block on a halted session is ALL ZEROES, because the
  //    request that carried it was rejected. Reading "the last one" therefore
  //    reports nothing exactly when a number is worth having. What we want is
  //    the last turn that actually ran, so walk backwards to the first block
  //    with a non-zero total.
  const key = '"usage":{';
  const starts: number[] = [];
  for (let i = tail.indexOf(key); i !== -1; i = tail.indexOf(key, i + 1)) starts.push(i);

  for (let s = starts.length - 1; s >= 0; s--) {
    const at = starts[s] as number;
    let depth = 0;
    let end = -1;
    for (let i = at + key.length - 1; i < tail.length; i++) {
      const c = tail[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const fields = tail.slice(at, end + 1);
    const num = (k: string): number => {
      const m = fields.match(new RegExp(`"${k}":(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const total =
      num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
    if (total > 0) return total;
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Recovery                                                                   */
/* ------------------------------------------------------------------------- */

export type RecoveryPlan =
  | { action: "none"; reason: string }
  | { action: "recover"; kind: HaltKind };

/**
 * Whether to act on a detected halt.
 *
 * THE GATE THAT MATTERS: keys are only ever sent into a session whose agent
 * process is alive. A tmux session routinely outlives the process it was made
 * for — the agent exits and the pane's shell remains — and typing `/clear` into
 * a shell does not clear anything, it runs a command. `detectState` already
 * distinguishes those cases; this function refuses to act on anything but
 * "live" so that distinction is load-bearing rather than decorative.
 */
export function planRecovery(state: string, halt: HaltKind | null): RecoveryPlan {
  if (halt === null) return { action: "none", reason: "no halt marker in transcript" };
  if (state !== "live") {
    return { action: "none", reason: `session is ${state}; refusing to send keys to a non-live pane` };
  }
  return { action: "recover", kind: halt };
}

/**
 * Literal text to type, sent with `-l` so tmux does not interpret it as key
 * names. Secrets never travel this path — send-keys lands in shell history as
 * well as the process table.
 */
export function sendLiteralArgv(session: string, text: string, tmux = "tmux"): string[] {
  return [tmux, "send-keys", "-t", session, "-l", text];
}

/** Press Enter in a session. Separate call: `-l` would type the word. */
export function sendEnterArgv(session: string, tmux = "tmux"): string[] {
  return [tmux, "send-keys", "-t", session, "Enter"];
}

/**
 * Absolute path of tmux, or the bare name if it cannot be resolved.
 *
 * Spawning bare `tmux` relies on PATH, and a watcher run from launchd, cron or
 * a non-interactive ssh gets a minimal PATH that does not include Homebrew.
 * That failure is silent and total — every session reads as absent, which the
 * sweep reports as "nothing wrong". Found by making exactly that mistake: a
 * non-interactive ssh reported a host as having no sessions while it was in
 * fact running two.
 */
export function resolveTmux(which: (n: string) => string | null): string {
  // Bare name when PATH search fails, NOT a guessed absolute path.
  //
  // This reverses an earlier belief of mine that an absolute fallback was the
  // safer one. It is the opposite: `spawn` resolves a bare name through PATH
  // and may still succeed, whereas a guessed absolute path that is wrong for
  // this machine is a guaranteed ENOENT. Guessing /opt/homebrew/bin/tmux on a
  // Linux host whose tmux lives under Linuxbrew is exactly how this was found.
  return which("tmux") ?? "tmux";
}

export interface ReorientInput {
  cwd: string;
  sessionId: string;
  haltKind: HaltKind;
  contextTokens: number | null;
  /** Most recent real asks, oldest first. Reconstructed, never remembered. */
  recentAsks: string[];
  /** Suite-side facts, supplied by a caller that holds credentials. */
  suiteFacts?: string[];
}

/**
 * The prompt handed to the session after the clear.
 *
 * Every line is reconstructed from the transcript or supplied by Suite. None of
 * it asks the model to recall anything, because the clear is precisely the
 * event that destroyed what it would recall.
 */
export function buildReorientation(input: ReorientInput): string {
  const lines: string[] = [];
  lines.push(
    "Your context was cleared automatically after the session hit " +
      (input.haltKind === "request_size"
        ? "the API's 32MB request limit"
        : "the context window") +
      ". Nothing is wrong. Take a moment to reorient before continuing.",
  );
  lines.push("");
  lines.push(`Working directory: ${input.cwd}`);
  if (input.contextTokens !== null) {
    lines.push(`Context at halt: ~${input.contextTokens.toLocaleString()} tokens`);
  }
  if (input.suiteFacts?.length) {
    lines.push("");
    lines.push("Open work (from Suite, authoritative):");
    for (const f of input.suiteFacts) lines.push(`- ${f}`);
  }
  if (input.recentAsks.length) {
    lines.push("");
    lines.push("Most recent things you were asked:");
    for (const a of input.recentAsks) lines.push(`- ${a}`);
  }
  lines.push("");
  lines.push(
    "Re-read any file before describing it; do not report progress you cannot see evidence for.",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* ------------------------------------------------------------------------- */

export interface TelemetrySink {
  /** Base URL, e.g. https://openobserve.example.invalid:5080 */
  endpoint: string;
  org: string;
  stream: string;
}

export interface TelemetryRequest {
  url: string;
  body: string;
  contentType: string;
}

/**
 * Build the ingest request.
 *
 * The `_json` endpoint takes a JSON ARRAY. Posting newline-delimited JSON — the
 * natural shape for a scanner — is rejected with
 * `SerdeJsonError# trailing characters at line 2 column 1`, which reads like a
 * malformed record rather than a wrong container.
 */
export function telemetryRequest(sink: TelemetrySink, events: HaltEvent[]): TelemetryRequest {
  const base = sink.endpoint.replace(/\/+$/, "");
  return {
    url: `${base}/api/${sink.org}/${sink.stream}/_json`,
    body: JSON.stringify(events),
    contentType: "application/json",
  };
}
