/**
 * `suite watch` — notice a halted Claude Code session, clear it, and hand the
 * fresh context back everything we can reconstruct about what it was doing.
 *
 * Self-contained: no dependencies beyond the runtime, no knowledge of any
 * particular observability stack, and nothing here reads a path specific to one
 * operator's machine. A box that configures no telemetry sink simply does not
 * emit; a box with no halted sessions does nothing at all.
 */
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { SuiteConfig } from "../config.ts";
import {
  type HaltEvent,
  type HaltKind,
  ASK_SCAN_BYTES,
  TAIL_BYTES,
  buildReorientation,
  contextTokens,
  conversationMb,
  detectHalt,
  planRecovery,
  sendEnterArgv,
  capturePaneArgv,
  clearPromptArgv,
  promptLanded,
  sendLiteralArgv,
  telemetryRequest,
  claudeRoot,
  projectSlugResolved,
  resolveTmux,
} from "../halt.ts";
import { SESSION_PREFIX, type TmuxDeps, detectState, liveTmuxDeps } from "../tmux.ts";
import { RSS_CEILING_BYTES, SUPERVISED_ENV } from "../supervisor.ts";
import { answerOnce, liveDialogIo, type DialogIo } from "../claude_dialogs.ts";
import { readAgentConnection } from "../agent_connections.ts";

export interface WatchDeps {
  tmux: TmuxDeps;
  now(): Date;
  sleep(ms: number): Promise<void>;
  post(url: string, body: string, contentType: string, auth: string | null): Promise<number>;
  readTail(path: string, bytes: number): string | null;
  realpath(path: string): string;
  listProjectDirs(home: string): string[];
  newestTranscript(dir: string): { path: string; bytes: number } | null;
  log(line: string): void;
  /**
   * Answers a Claude Code launch dialog left on screen in a session we own —
   * the backstop for a launch whose own poll ran out (a very slow boot).
   * Optional: a caller that supplies nothing answers nothing.
   */
  dialogs?: DialogIo;
  /**
   * The runtime id the agent folder `cwd` is recorded as, or null. Optional: a
   * caller that supplies nothing reports null for every event. Never resolved
   * from the machine-level connection.
   */
  runtimeIdFor?(cwd: string): string | null;
}

/** {@link WatchDeps.runtimeIdFor} from the per-folder store under `env`. Never throws. */
export function runtimeIdResolver(env: Record<string, string | undefined>): (cwd: string) => string | null {
  return (cwd) => {
    try {
      return readAgentConnection(env, cwd).connection?.record.runtimeId ?? null;
    } catch {
      return null;
    }
  };
}

export interface WatchOptions {
  apply: boolean;
  config: SuiteConfig;
  auth: string | null;
  host: string;
  home: string;
}

/** One tmux session that belongs to us, with the directory it runs in. */
export interface WatchTarget {
  session: string;
  cwd: string;
}

/**
 * Parse `session_name<TAB>pane_current_path` rows.
 *
 * Restricted to sessions this CLI named. Other people's tmux sessions on a
 * shared box are not ours to type into, and a stray `/clear` sent to one would
 * be indistinguishable from the user's own keystrokes.
 */
export function parseTargets(stdout: string, prefix: string = SESSION_PREFIX): WatchTarget[] {
  const out: WatchTarget[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const [session, cwd] = line.split("\t");
    if (!session || !cwd) continue;
    if (!session.startsWith(`${prefix}-`)) continue;
    if (seen.has(session)) continue;
    seen.add(session);
    out.push({ session, cwd });
  }
  return out;
}

/**
 * The last human asks, reconstructed from the transcript.
 *
 * A federated agent's real instructions do not arrive as bare user text — they
 * arrive wrapped in a `<channel>` envelope that also quotes several previous
 * turns for context. Taking the whole envelope would hand the fresh session a
 * transcript of its own recent history and call it an instruction; the live ask
 * is the `Current message:` tail. Everything else in the envelope is discarded
 * on purpose.
 */
export function recentAsks(tail: string, limit = 5): string[] {
  const asks: string[] = [];
  for (const line of tail.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    let rec: { message?: { content?: unknown } };
    try {
      rec = JSON.parse(line) as { message?: { content?: unknown } };
    } catch {
      continue;
    }
    const content = rec.message?.content;
    if (typeof content !== "string") continue;
    let text = content.trim();
    if (text.includes("system-reminder") || text.startsWith("<task-notification")) continue;
    if (text.startsWith("<channel")) {
      const idx = text.lastIndexOf("Current message:");
      if (idx === -1) continue;
      text = text.slice(idx + "Current message:".length).replace(/<\/channel>\s*$/, "").trim();
    }
    if (text) asks.push(text.replace(/\s+/g, " ").slice(0, 280));
  }
  return asks.slice(-limit);
}

/**
 * Every project directory Claude Code has written to on this box.
 *
 * Discovery is TRANSCRIPT-FIRST, not tmux-first, and that is deliberate. The
 * host where this failure is most frequent turned out to run its agent outside
 * any suite-cli tmux session — a tmux-only sweep saw nothing there at all,
 * while its transcripts showed 9 of 12 sessions halted. Observation must not
 * depend on us owning the session; only the recovery keystrokes do.
 */
export function liveListProjectDirs(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const root = `${claudeRoot(home, env)}/projects`;
  try {
    return readdirSync(root).map((n) => `${root}/${n}`);
  } catch {
    // Absent root: say so rather than sweeping nothing and calling it healthy.
    // An unreadable or relocated state directory looks identical to a box with
    // no halted sessions, and only one of those is good news.
    console.error(`suite watch: no transcripts under ${root} — nothing to inspect`);
    return [];
  }
}

/** Newest `.jsonl` in a transcript directory, or null if the dir is absent. */
export function liveNewestTranscript(dir: string): { path: string; bytes: number } | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { path: string; bytes: number; mtime: number } | null = null;
  for (const n of names) {
    const p = `${dir}/${n}`;
    try {
      const st = statSync(p);
      if (!best || st.mtimeMs > best.mtime) best = { path: p, bytes: st.size, mtime: st.mtimeMs };
    } catch {
      /* raced with a delete; skip */
    }
  }
  return best ? { path: best.path, bytes: best.bytes } : null;
}

/**
 * Read the final `bytes` of a file — genuinely, by seeking.
 *
 * The previous version claimed this in a comment and then called
 * `readFileSync` on the whole file before taking a subarray, which allocates
 * the ENTIRE transcript. On the box this was written on that looked fine, since
 * the newest transcript per project was ~25MB. On the box it was about to be
 * deployed to, the newest transcripts are 1346MB and 1042MB — multi-gigabyte
 * allocations every sweep, forever. The comment was right and the code was
 * wrong, which is the combination least likely to be noticed in review.
 */
export function liveReadTail(path: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const length = Math.min(bytes, size);
    if (length === 0) return "";
    const buf = Buffer.allocUnsafe(length);
    fd = openSync(path, "r");
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Total resident memory of a session's whole process tree, keyed by session.
 *
 * Exists because the transcript-based sampling is blind to any agent that is
 * not Claude Code. A DeepSeek-harness agent writes no `.claude` transcript at
 * all, so it contributes no occupancy sample and is invisible to this watcher —
 * which is exactly the gap that made an earlier host incident unattributable:
 * the process table died with the box and nothing had ever recorded what the
 * agents were consuming. RSS is harness-agnostic; every agent has it.
 *
 * The whole descendant tree is summed rather than the pane's own process,
 * because the agent is a CHILD of the pane shell (see detectState) and often
 * spawns its own children.
 */
export function rssBySession(
  paneStdout: string,
  psStdout: string,
): Map<string, number> {
  const rss = new Map<number, number>();
  const rows: { pid: number; ppid: number }[] = [];
  for (const line of psStdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    rows.push({ pid, ppid: Number(m[2]) });
    rss.set(pid, Number(m[3]) * 1024);
  }
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);

  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const line of paneStdout.split("\n")) {
    const [session, pid] = line.split("\t");
    if (!session || !pid || seen.has(session)) continue;
    seen.add(session);
    let total = 0;
    const stack = [Number(pid)];
    const visited = new Set<number>();
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      if (visited.has(cur)) continue;
      visited.add(cur);
      total += rss.get(cur) ?? 0;
      for (const k of kids.get(cur) ?? []) stack.push(k);
    }
    out.set(session, total);
  }
  return out;
}

/** How many times to retype a reorientation that did not land whole. */
export const REORIENT_ATTEMPTS = 3;

/**
 * Recover one session: clear it, then reorient it.
 *
 * The two sends are deliberately separate, with a pause between. `/clear` has
 * to be accepted and the TUI redrawn before the next text arrives; typing the
 * reorientation into a prompt that is still tearing down loses it silently, and
 * a silently lost reorientation is worse than none because the session looks
 * handled.
 *
 * THE PAUSE IS NOT SUFFICIENT, WHICH IS WHY THE PANE IS READ BACK. On the first
 * real recovery this watcher performed, 1.5s was not enough: the reorientation
 * was typed into a prompt still redrawing and only its last two lines arrived.
 * The agent woke holding a truncated fragment and asked what had been cut off,
 * while the log said "cleared and reoriented". A fixed pause cannot be proven
 * long enough on a machine nobody is watching; reading back what is actually in
 * the prompt can. So: type, look, and only press Enter once the opening line is
 * there — otherwise clear the prompt and type it again.
 *
 * Returns whether the reorientation was delivered whole. A false is the honest
 * answer for a session that was cleared and then left without its briefing, and
 * the caller must not report it as recovered.
 */
export async function recoverSession(
  deps: WatchDeps,
  session: string,
  prompt: string,
): Promise<boolean> {
  const tmux = resolveTmux(deps.tmux.which);
  await deps.tmux.run(sendLiteralArgv(session, "/clear", tmux));
  await deps.tmux.run(sendEnterArgv(session, tmux));
  await deps.sleep(1500);

  for (let attempt = 1; attempt <= REORIENT_ATTEMPTS; attempt++) {
    await deps.tmux.run(sendLiteralArgv(session, prompt, tmux));
    const pane = await deps.tmux.run(capturePaneArgv(session, tmux));
    if (promptLanded(pane.stdout, prompt)) {
      await deps.tmux.run(sendEnterArgv(session, tmux));
      return true;
    }
    // Whatever partial text did arrive must go, or the retry appends to it and
    // the agent receives the fragment twice over.
    await deps.tmux.run(clearPromptArgv(session, tmux));
    await deps.sleep(1500);
  }
  return false;
}

/**
 * Map each tmux pane we own to the project slug its working directory writes
 * to, so a halted transcript can be matched back to a session we may type into.
 * Sessions we did not name are excluded, and a transcript with no matching
 * session is still observed — just not recovered.
 */
export function sessionsBySlug(
  targets: WatchTarget[],
  realpath: (p: string) => string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of targets) map.set(projectSlugResolved(t.cwd, realpath), t.session);
  return map;
}

/**
 * Whether the process has outgrown its own ceiling and should exit for a clean
 * restart. Returns a reason so the log says why, rather than the process simply
 * vanishing and looking like a crash.
 */
export function overCeiling(rssBytes: number, ceiling = RSS_CEILING_BYTES): string | null {
  if (rssBytes <= ceiling) return null;
  return `rss ${Math.round(rssBytes / 1048576)}MB exceeded ceiling ${Math.round(ceiling / 1048576)}MB`;
}

export async function runWatch(deps: WatchDeps, opts: WatchOptions): Promise<HaltEvent[]> {
  const panes = await deps.tmux.run([
    resolveTmux(deps.tmux.which),
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_current_path}",
  ]);
  const targets = parseTargets(panes.stdout);
  const bySlug = sessionsBySlug(targets, deps.realpath);
  const events: HaltEvent[] = [];

  // A launch dialog still on screen in one of OUR sessions. One key per session
  // per pass: the sweep comes round again, so it never needs to wait for a
  // redraw, and a two-step dialog simply takes two passes. Exact-text matching
  // (src/claude_dialogs.ts) is what makes it safe to look at every session we
  // named, whatever harness runs in it.
  if (opts.apply && deps.dialogs !== undefined) {
    for (const t of targets) await answerOnce(deps.dialogs, { session: t.session, cwd: t.cwd, home: opts.home });
  }

  // Resident memory per session, gathered once. Harness-agnostic, so it covers
  // agents this watcher can otherwise not see at all.
  // A SECOND pane query, deliberately: the targets query above yields
  // session+path for slug resolution, while RSS needs session+pid. Reusing one
  // format for both would silently mis-parse — it did, and produced rss=null
  // for every session until the probe showed it.
  const panePids = await deps.tmux.run([
    resolveTmux(deps.tmux.which),
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_pid}",
  ]);
  const psOut = await deps.tmux.run(["ps", "-eo", "pid=,ppid=,rss=,args="]);
  const rss = rssBySession(panePids.stdout, psOut.stdout);
  const covered = new Set<string>();
  // Each owned session's runtime, from ITS folder's record. Resolved once per pass.
  const runtimeBySession = new Map<string, string | null>();
  const runtimeOf = (session: string | null): string | null => {
    if (session === null || session === "" || deps.runtimeIdFor === undefined) return null;
    if (!runtimeBySession.has(session)) {
      const target = targets.find((t) => t.session === session);
      runtimeBySession.set(session, target === undefined ? null : deps.runtimeIdFor(target.cwd));
    }
    return runtimeBySession.get(session) ?? null;
  };

  for (const dir of deps.listProjectDirs(opts.home)) {
    const newest = deps.newestTranscript(dir);
    if (!newest) continue;
    const tail = deps.readTail(newest.path, TAIL_BYTES);
    if (tail === null) continue;

    const halt: HaltKind | null = detectHalt(tail);
    const slug = dir.split("/").pop() ?? "";
    const session = bySlug.get(slug) ?? null;
    const sessionId = newest.path.split("/").pop()?.replace(/\.jsonl$/, "") ?? "unknown";

    // Only a session we own and that is genuinely alive may be typed into.
    const state = session ? await detectState(session, deps.tmux) : "none";
    const plan = planRecovery(state, halt);

    if (halt === null) {
      // Healthy AND ours: occupancy is only ever readable here (see HaltEvent),
      // so this sample is the only thing that can ever teach us to predict.
      if (state !== "live") continue;
      if (session) covered.add(session);
      events.push({
        host: opts.host,
        session: session ?? "",
        project: slug,
        session_id: sessionId,
        event_kind: "sample",
        halt_kind: null,
        conversation_mb: null,
        file_bytes: newest.bytes,
        context_tokens: contextTokens(tail),
        rss_bytes: session ? (rss.get(session) ?? null) : null,
        runtime_id: runtimeOf(session),
        recovered: false,
        event_time: deps.now().toISOString(),
        source: "suite_cli_halt_watch",
      });
      continue;
    }

    let recovered = false;
    if (plan.action === "recover" && session) {
      if (opts.apply) {
        const prompt = buildReorientation({
          cwd: dir,
          sessionId,
          haltKind: plan.kind,
          contextTokens: contextTokens(tail),
          recentAsks: recentAsks(deps.readTail(newest.path, ASK_SCAN_BYTES) ?? tail),
        });
        recovered = await recoverSession(deps, session, prompt);
        deps.log(
          recovered
            ? `${session}: ${halt} — cleared and reoriented`
            : `${session}: ${halt} — CLEARED BUT NOT REORIENTED after ${REORIENT_ATTEMPTS} attempts; the session is usable but unbriefed`,
        );
      } else {
        deps.log(`${session}: ${halt} — would clear and reorient (dry run)`);
      }
    } else {
      // Recorded, not recovered. A halt on a session we cannot address is still
      // worth counting; silently dropping it would under-report the very hosts
      // that suffer most.
      deps.log(`${slug}: ${halt} — observed only (${session ? plan.action === "none" ? "not live" : "" : "no owned session"})`);
    }

    if (session) covered.add(session);
    events.push({
      host: opts.host,
      session: session ?? "",
      project: slug,
      session_id: sessionId,
      event_kind: "halt",
      halt_kind: halt,
      conversation_mb: conversationMb(tail),
      file_bytes: newest.bytes,
      context_tokens: contextTokens(tail),
      rss_bytes: session ? (rss.get(session) ?? null) : null,
      runtime_id: runtimeOf(session),
      recovered,
      event_time: deps.now().toISOString(),
      source: "suite_cli_halt_watch",
    });
  }

  // Sessions with NO Claude Code transcript — a DeepSeek-harness agent, say.
  // They produce no occupancy figure by construction, but RSS still describes
  // them, and a memory event nobody recorded is the reason an earlier host
  // incident could not be attributed to anything.
  for (const [session, bytes] of rss) {
    if (covered.has(session)) continue;
    events.push({
      host: opts.host,
      session,
      project: "",
      session_id: "",
      event_kind: "sample",
      halt_kind: null,
      conversation_mb: null,
      file_bytes: 0,
      context_tokens: null,
      rss_bytes: bytes,
      runtime_id: runtimeOf(session),
      recovered: false,
      event_time: deps.now().toISOString(),
      source: "suite_cli_halt_watch",
    });
  }

  const sink = opts.config.telemetry;
  if (sink && events.length > 0) {
    const req = telemetryRequest(sink, events);
    const code = await deps.post(req.url, req.body, req.contentType, opts.auth);
    // A collector being down must never undo a recovery that already happened.
    deps.log(`telemetry: ${events.length} event(s) -> HTTP ${code}`);
  }
  return events;
}

/* ------------------------------------------------------------------------- */
/* Live wiring                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Real dependencies.
 *
 * `post` swallows transport failures into a status code rather than throwing:
 * by the time telemetry is emitted the recovery has already happened, and an
 * unreachable collector must not turn a successful clear into a crash.
 */
export function liveWatchDeps(
  env: Record<string, string | undefined> = process.env,
  tmux?: TmuxDeps,
): WatchDeps {
  return {
    tmux: tmux ?? liveTmuxDeps(env),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readTail: liveReadTail,
    realpath: realpathSync,
    listProjectDirs: liveListProjectDirs,
    newestTranscript: liveNewestTranscript,
    log: (line) => console.log(`suite watch: ${line}`),
    dialogs: liveDialogIo(tmux ?? liveTmuxDeps(env), env.HOME ?? "", (line) => console.log(`suite watch: ${line}`)),
    runtimeIdFor: runtimeIdResolver(env),
    async post(url, body, contentType, auth) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            ...(auth ? { Authorization: auth } : {}),
          },
          body,
        });
        return res.status;
      } catch (err) {
        // Say WHY. A bare 0 cost an hour of blind debugging: the daemon was
        // sweeping correctly and only the POST was failing, and "HTTP 0"
        // looked identical to a collector that was merely down.
        console.error(`suite watch: telemetry POST failed: ${(err as Error).message}`);
        return 0;
      }
    },
  };
}

export interface WatchArgs {
  apply: boolean;
  once: boolean;
  intervalSeconds: number;
  install: boolean;
  /**
   * Recover this session NOW, whether or not it has halted.
   *
   * Exists so the recovery path can be proven on demand instead of waiting for
   * a real halt — the clear and the reorientation are the two steps that only
   * ever run in the failure case, which is exactly when nobody is watching. It
   * takes an explicit session name and never operates on "whatever is halted",
   * so it cannot be aimed at a working agent by accident.
   */
  force?: string;
}

/**
 * Run the recovery path against one named session, regardless of halt state.
 *
 * Still gated on the session being LIVE: typing into a pane whose agent has
 * exited runs a shell command instead of clearing anything, and that is true
 * whether the recovery was triggered by a halt or by hand.
 */
export async function forceRecover(
  deps: WatchDeps,
  opts: WatchOptions,
  session: string,
): Promise<{ recovered: boolean; reason: string; prompt: string }> {
  const state = await detectState(session, deps.tmux);
  if (state !== "live") {
    return { recovered: false, reason: `session is ${state}; refusing to type into it`, prompt: "" };
  }

  const panes = await deps.tmux.run([
    resolveTmux(deps.tmux.which),
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_current_path}",
  ]);
  const target = parseTargets(panes.stdout).find((t) => t.session === session);
  if (!target) return { recovered: false, reason: "session not found", prompt: "" };

  const dir = `${claudeRoot(opts.home, deps.tmux.env)}/projects/${projectSlugResolved(target.cwd, deps.realpath)}`;
  const newest = deps.newestTranscript(dir);
  const tail = newest ? (deps.readTail(newest.path, TAIL_BYTES) ?? "") : "";

  // Asks need a wider window than halt detection — see ASK_SCAN_BYTES.
  const askTail = newest ? (deps.readTail(newest.path, ASK_SCAN_BYTES) ?? tail) : tail;

  const prompt = buildReorientation({
    cwd: target.cwd,
    sessionId: newest?.path.split("/").pop()?.replace(/\.jsonl$/, "") ?? "unknown",
    // Honest: this was forced, not a real context-window halt.
    haltKind: "context_window",
    contextTokens: contextTokens(tail),
    recentAsks: recentAsks(askTail),
  });

  if (!opts.apply) return { recovered: false, reason: "dry run", prompt };
  const landed = await recoverSession(deps, session, prompt);
  return {
    recovered: landed,
    reason: landed
      ? "cleared and reoriented"
      : "cleared, but the reorientation never landed in the prompt",
    prompt,
  };
}

/**
 * Whether this invocation should install its own service before doing anything.
 *
 * The point is that there is no separate setup step to discover: a human who
 * types `suite watch` ends up with a watchdog that survives logout, rather than
 * a loop bound to a terminal that closes. Three cases do NOT self-install:
 *
 *  - the daemon itself, marked by SUPERVISED_ENV, or it would reinstall on
 *    every restart forever;
 *  - `--once`, which exists for an operator's own timer that already owns the
 *    schedule;
 *  - `--dry-run`, which must never change the machine it is inspecting.
 */
export function shouldSelfInstall(
  args: Pick<WatchArgs, "once" | "apply" | "install">,
  env: Record<string, string | undefined>,
): boolean {
  if (!args.install) return false;
  if (env[SUPERVISED_ENV] === "1") return false;
  if (args.once) return false;
  if (!args.apply) return false;
  return true;
}

/**
 * `--dry-run` reports without typing anything. It is not the default: the
 * command exists to recover sessions, and a watcher that has to be asked twice
 * is one nobody runs. `--once` is for a cron/timer that owns its own schedule.
 */
export function parseWatchArgs(argv: string[]): WatchArgs {
  const apply = !argv.includes("--dry-run");
  const once = argv.includes("--once");
  const i = argv.indexOf("--interval");
  const raw = i === -1 ? NaN : Number(argv[i + 1]);
  const intervalSeconds = Number.isFinite(raw) && raw >= 10 ? raw : 60;
  const install = !argv.includes("--no-install");
  const f = argv.indexOf("--force");
  const force = f === -1 ? undefined : argv[f + 1];
  return { apply, once, intervalSeconds, install, force };
}
