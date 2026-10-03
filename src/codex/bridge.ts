/**
 * The bridge between a Suite runtime channel and one `codex app-server`.
 *
 *   Suite ──attention──▶ bridge ──turn/start──▶ codex app-server
 *   Suite ◀──reply────── bridge ◀──suite_reply── Codex (via the suite-channel MCP server)
 *
 * ONE THREAD PER SPACE. Each Suite space gets its own persistent Codex thread,
 * and its id is saved, so a restart resumes the same conversation
 * (`thread/resume`) instead of starting cold. Why per space, not one thread
 * for the whole runtime and not one per message:
 *
 *  - a space IS a conversation: people expect the agent to remember what was
 *    said there, and not to bring another space's context into it;
 *  - task work already arrives per space — each task dispatches into its own
 *    execution space — so per space is also per task, without a second rule;
 *  - two turns on one thread interleave into nonsense, so turns are serialised
 *    per space (later dispatches queue, oldest dropped past
 *    {@link MAX_PENDING_PER_SPACE}, said out loud), while different spaces run
 *    concurrently instead of waiting behind each other.
 *
 * A dispatch with no space (a responsibility with no `metadata.space_id`)
 * shares one thread, keyed {@link NO_SPACE}.
 *
 * REPLIES ARE THE AGENT'S, AS FOR CLAUDE. Codex's final message is NOT posted:
 * the agent replies by calling `suite_reply` on the `suite-channel` MCP server,
 * exactly as a Claude agent does (`./reply_mcp.ts` forwards the call here and
 * this pushes it on the runtime socket, the only way core accepts a reply).
 * The two exceptions are the bridge's own: a failed turn is reported in the
 * space, because silence is indistinguishable from being ignored, and the
 * typing indicator is cleared when a turn ends.
 *
 * APPROVALS follow the configured policy — see {@link answerServerRequest}.
 */
import type { AppServerClient } from "./app_server.ts";
import { RpcError } from "./app_server.ts";
import type { Payload } from "./phoenix.ts";
import {
  SERVER_REQUESTS,
  type AskForApproval,
  type CommandExecutionRequestApprovalParams,
  type FileChangeRequestApprovalParams,
  type PermissionsRequestApprovalParams,
  type SandboxMode,
  type ThreadResumeResponse,
  type ThreadStartResponse,
  type TurnCompletedNotification,
  type TurnStartResponse,
} from "./protocol.ts";

export const NO_SPACE = "suite:no-space";
export const MAX_PENDING_PER_SPACE = 5;
export const HISTORY_TURNS = 20;
/** Two copies of one dispatch closer together than this are one dispatch. */
export const DEDUPE_MS = 2_000;

export type ApprovalPolicy = "accept" | "decline";

/** The channel surface the bridge needs; {@link PhoenixChannel} provides it. */
export interface ChannelLike {
  on(event: string, fn: (payload: Payload) => void): void;
  push(event: string, payload: Payload): Promise<{ status: string; response: Payload }>;
}

export interface BridgeOptions {
  cwd: string;
  approvals: ApprovalPolicy;
  sandbox: SandboxMode;
  log(line: string): void;
  now?(): number;
  /** Saved thread ids, keyed by space. */
  loadThreads(): Record<string, string>;
  saveThreads(threads: Record<string, string>): void;
}

/** What the model is told once per thread. Adapted from the Claude channel plugin's instructions. */
export const DEVELOPER_INSTRUCTIONS = [
  "You are an agent federated into Startup Suite. Messages from Suite arrive in your turns wrapped as",
  '<channel source="startup-suite" space_id="..." message_id="..." task_id="..." reason="..." author="...">…</channel>.',
  "Your final message is NOT delivered to anyone. To say something in Suite, call the `suite_reply` tool on the",
  "`suite-channel` MCP server, passing the `space_id` attribute from the inbound tag. Call `suite_typing` with",
  "`typing: true` before composing a reply. For long replies use `suite_reply_chunk` with one `chunk_id` and the",
  "cumulative `text`, finishing with `done: true`. `suite_reply_with_media` attaches base64 files.",
  "The `startup-suite` MCP server carries the rest of the Suite tools (tasks, plans, memory, canvases), the same",
  "bundles a Claude agent has. A task dispatch carries task_id; do the work it describes.",
  "Only reply to a real space id from the tag, never a task id.",
].join(" ");

/** `"` and `<`/`>` would end the attribute or the tag early. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Signal = Record<string, unknown> & { metadata?: Record<string, unknown> };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A field from `signal`, falling back to `signal.metadata` — core writes ids in both. */
function field(sig: Signal, key: string): string | undefined {
  return str(sig[key]) ?? str(sig.metadata?.[key]);
}

export function spaceKey(payload: Payload): string {
  const sig = (payload.signal ?? {}) as Signal;
  return field(sig, "space_id") ?? NO_SPACE;
}

export function attentionBody(payload: Payload): string {
  const sig = (payload.signal ?? {}) as Signal;
  const msg = (payload.message ?? {}) as Record<string, unknown>;
  return str(msg.content) ?? field(sig, "prompt") ?? "";
}

/**
 * Should this attention become a turn at all? Same rule as the Claude plugin:
 * an empty body with nothing to correlate it to is noise.
 */
export function isActionable(payload: Payload): boolean {
  const sig = (payload.signal ?? {}) as Signal;
  if (attentionBody(payload) !== "") return true;
  return field(sig, "task_id") !== undefined || field(sig, "message_id") !== undefined || field(sig, "responsibility_key") !== undefined;
}

const META_KEYS = [
  "space_id",
  "message_id",
  "task_id",
  "task_status",
  "reason",
  "author",
  "author_id",
  "responsibility_key",
  "feature",
  "trigger_kind",
  "plan_id",
  "stage_id",
  "project_id",
] as const;

/**
 * (attention, is this the first in its space since start) → the turn text.
 * The envelope matches what a Claude agent sees, so prompts and habits carry
 * over between harnesses.
 */
export function renderAttention(payload: Payload, withHistory: boolean): string {
  const sig = (payload.signal ?? {}) as Signal;
  const msg = (payload.message ?? {}) as Record<string, unknown>;
  const meta: [string, string][] = [];
  for (const key of META_KEYS) {
    const v = key === "author" || key === "author_id" ? str(msg[key]) : field(sig, key);
    if (v !== undefined) meta.push([key, v]);
  }
  let body = attentionBody(payload);
  if (body === "") {
    const what = field(sig, "responsibility_key") ?? field(sig, "reason") ?? "dispatch";
    const trigger = field(sig, "trigger_kind");
    body = `System dispatch: ${what}${trigger ? ` (${trigger})` : ""} — no rendered prompt.`;
  }
  const history = Array.isArray(payload.history) ? (payload.history as Record<string, unknown>[]) : [];
  if (withHistory && history.length > 0) {
    const lines = history
      .slice(-HISTORY_TURNS)
      .map((h) => `${str(h.author) ?? "unknown"}: ${str(h.content) ?? ""}`);
    body = [`Recent context (last ${lines.length} turns in this space):`, ...lines, "", "---", "", "Current message:", body].join("\n");
  }
  const attrs = meta.map(([k, v]) => ` ${k}="${attr(v)}"`).join("");
  return `<channel source="startup-suite"${attrs}>\n${body.replace(/<\/channel>/gi, "<\\/channel>")}\n</channel>`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tools `suite-channel` offers, and the socket event each becomes. */
export const CHANNEL_TOOLS = ["suite_reply", "suite_reply_with_media", "suite_typing", "suite_reply_chunk"] as const;
export type ChannelTool = (typeof CHANNEL_TOOLS)[number];

export class CodexBridge {
  private readonly threads: Record<string, string>;
  private readonly live = new Map<string, string>();
  private readonly historySent = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly pending = new Map<string, Payload[]>();
  private readonly turnWaiters = new Map<string, (n: TurnCompletedNotification) => void>();
  private readonly recent = new Map<string, number>();
  private readonly idle: (() => void)[] = [];

  constructor(
    private readonly channel: ChannelLike,
    private readonly codex: AppServerClient,
    private readonly opts: BridgeOptions,
  ) {
    this.threads = { ...opts.loadThreads() };
    channel.on("attention", (p) => this.onAttention(p));
    channel.on("ping", () => void channel.push("pong", { timestamp: new Date(this.now()).toISOString() }));
    let saidMeeting = false;
    channel.on("meeting_transcript", () => {
      if (!saidMeeting) opts.log("meeting transcripts are not bridged to Codex (0.7.0); ignoring them");
      saidMeeting = true;
    });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get approvalPolicy(): AskForApproval {
    // accept: Codex never stops to ask — the parity of `suite claude`'s
    // --dangerously-skip-permissions. decline: Codex asks, and is told no.
    return this.opts.approvals === "accept" ? "never" : "on-request";
  }

  /** Resolves once no turn is running and nothing is queued. For tests and shutdown. */
  whenIdle(): Promise<void> {
    if (this.inflight.size === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  /* Inbound --------------------------------------------------------------- */

  onAttention(payload: Payload): void {
    if (!isActionable(payload)) {
      this.opts.log(`dropped an attention with no body and nothing to correlate (${spaceKey(payload)})`);
      return;
    }
    const sig = (payload.signal ?? {}) as Signal;
    const key = [spaceKey(payload), field(sig, "message_id"), field(sig, "responsibility_key"), field(sig, "task_id"), field(sig, "stage_id"), attentionBody(payload).slice(0, 50)].join("|");
    const at = this.recent.get(key);
    const now = this.now();
    if (at !== undefined && now - at < DEDUPE_MS) return;
    this.recent.set(key, now);
    if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value as string);
    void this.dispatch(payload);
  }

  private async dispatch(payload: Payload): Promise<void> {
    const space = spaceKey(payload);
    if (this.inflight.has(space)) {
      const queue = this.pending.get(space) ?? [];
      queue.push(payload);
      while (queue.length > MAX_PENDING_PER_SPACE) {
        queue.shift();
        this.opts.log(`${space}: queue full, dropped the oldest waiting dispatch`);
      }
      this.pending.set(space, queue);
      return;
    }
    this.inflight.add(space);
    try {
      await this.runTurn(space, payload);
    } catch (error) {
      this.opts.log(`${space}: turn error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.inflight.delete(space);
      const queue = this.pending.get(space);
      const next = queue?.shift();
      if (queue !== undefined && queue.length === 0) this.pending.delete(space);
      if (next !== undefined) setTimeout(() => void this.dispatch(next), 0);
      else if (this.inflight.size === 0 && this.pending.size === 0) for (const r of this.idle.splice(0)) r();
    }
  }

  private async ensureThread(space: string): Promise<string> {
    const running = this.live.get(space);
    if (running !== undefined) return running;
    const common = { cwd: this.opts.cwd, approvalPolicy: this.approvalPolicy, sandbox: this.opts.sandbox, developerInstructions: DEVELOPER_INSTRUCTIONS };
    const saved = this.threads[space];
    if (saved !== undefined) {
      try {
        const r = await this.codex.request<ThreadResumeResponse>("thread/resume", { threadId: saved, ...common, excludeTurns: true });
        this.live.set(space, r.thread.id);
        this.opts.log(`${space}: resumed thread ${r.thread.id}`);
        return r.thread.id;
      } catch (error) {
        this.opts.log(`${space}: could not resume thread ${saved} (${error instanceof Error ? error.message : String(error)}); starting a new one`);
      }
    }
    const r = await this.codex.request<ThreadStartResponse>("thread/start", { ...common, serviceName: "suite" });
    this.live.set(space, r.thread.id);
    this.threads[space] = r.thread.id;
    this.opts.saveThreads({ ...this.threads });
    this.opts.log(`${space}: started thread ${r.thread.id} (${r.model})`);
    return r.thread.id;
  }

  private async runTurn(space: string, payload: Payload): Promise<void> {
    const realSpace = UUID.test(space);
    if (realSpace) void this.channel.push("typing", { space_id: space, typing: true });
    const threadId = await this.ensureThread(space);
    const text = renderAttention(payload, !this.historySent.has(space));
    this.historySent.add(space);

    const done = new Promise<TurnCompletedNotification>((resolve) => this.turnWaiters.set(threadId, resolve));
    try {
      const started = await this.codex.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      this.opts.log(`${space}: turn ${started.turn.id} started`);
    } catch (error) {
      this.turnWaiters.delete(threadId);
      throw error;
    }
    const finished = await done;
    const turn = finished.turn;
    this.opts.log(`${space}: turn ${turn.id} ${turn.status}`);
    if (turn.status === "failed" && realSpace) {
      await this.channel.push("reply", {
        space_id: space,
        content: `I could not complete that turn — \`${turn.error?.message ?? "unknown error"}\`.`,
      });
    }
    if (realSpace) void this.channel.push("typing", { space_id: space, typing: false });
  }

  /* From the app-server --------------------------------------------------- */

  onNotification(method: string, params: unknown): void {
    if (method === "turn/completed") {
      const n = params as TurnCompletedNotification;
      const waiter = this.turnWaiters.get(n.threadId);
      if (waiter !== undefined) {
        this.turnWaiters.delete(n.threadId);
        waiter(n);
      }
    } else if (method === "error") {
      const p = params as { error?: { message?: string }; willRetry?: boolean };
      this.opts.log(`codex error: ${p.error?.message ?? "unknown"}${p.willRetry ? " (retrying)" : ""}`);
    }
  }

  /**
   * Answer a server → client request according to the approval policy.
   *
   * Nobody is at a Suite runtime's keyboard, so every request is answered at
   * once — an unanswered request stalls the turn forever — and every answer
   * is logged with what it was about.
   *
   *  - command / file-change approvals: `accept` or `decline`, per policy;
   *  - a permissions request: the requested permissions for this turn, or
   *    none, per policy;
   *  - an MCP elicitation (a form for a human) and a request for user input:
   *    declined / answered empty under BOTH policies — there is no human to
   *    fill them in, and inventing answers would be worse than refusing;
   *  - auth-token refresh and attestation: refused. Codex owns its login; this
   *    bridge never handles a token.
   */
  async answerServerRequest(method: string, params: unknown): Promise<unknown> {
    const accept = this.opts.approvals === "accept";
    const verdict = accept ? "accept" : "decline";
    switch (method) {
      case SERVER_REQUESTS.commandApproval: {
        const p = params as CommandExecutionRequestApprovalParams;
        this.opts.log(`approval: ${verdict} command ${JSON.stringify(p.command ?? "")}${p.reason ? ` (${p.reason})` : ""}`);
        return { decision: verdict };
      }
      case SERVER_REQUESTS.fileChangeApproval: {
        const p = params as FileChangeRequestApprovalParams;
        this.opts.log(`approval: ${verdict} file change ${p.itemId}${p.reason ? ` (${p.reason})` : ""}`);
        return { decision: verdict };
      }
      case SERVER_REQUESTS.permissionsApproval: {
        const p = params as PermissionsRequestApprovalParams;
        this.opts.log(`approval: ${verdict} permissions ${JSON.stringify(p.permissions)}`);
        return { permissions: accept ? p.permissions : {}, scope: "turn" };
      }
      case SERVER_REQUESTS.legacyExecCommand:
      case SERVER_REQUESTS.legacyApplyPatch:
        this.opts.log(`approval: ${verdict} ${method}`);
        return { decision: accept ? "approved" : { denied: { rejection: "declined by the suite codex approval policy" } } };
      case SERVER_REQUESTS.elicitation:
        this.opts.log("approval: decline MCP elicitation (no human to answer it)");
        return { action: "decline", content: null, _meta: null };
      case SERVER_REQUESTS.userInput:
        this.opts.log("approval: empty answer to a request for user input (no human to answer it)");
        return { answers: {} };
      default:
        this.opts.log(`refused server request ${method}`);
        throw new RpcError(-32601, `suite codex does not handle ${method}`);
    }
  }

  /* From the suite-channel MCP server ------------------------------------- */

  /** Forward one channel tool call to the socket. Returns the text the tool reports. */
  async channelTool(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const space = str(args.space_id);
    if (space === undefined || !UUID.test(space)) {
      return { ok: false, text: `space_id must be the space UUID from the inbound <channel> tag, got ${JSON.stringify(args.space_id ?? null)}` };
    }
    const report = (r: { status: string; response: Payload }, what: string) =>
      r.status === "ok" ? { ok: true, text: `${what} sent` } : { ok: false, text: `${what} not sent: ${r.status} ${JSON.stringify(r.response)}` };
    switch (tool) {
      case "suite_reply":
        return report(await this.channel.push("reply", { space_id: space, content: String(args.content ?? "") }), "reply");
      case "suite_reply_with_media":
        return report(
          await this.channel.push("reply_with_media", { space_id: space, content: String(args.content ?? ""), attachments: args.attachments ?? [] }),
          "reply with media",
        );
      case "suite_typing":
        void this.channel.push("typing", { space_id: space, typing: args.typing === true });
        return { ok: true, text: "typing updated" };
      case "suite_reply_chunk": {
        const chunk = { space_id: space, chunk_id: String(args.chunk_id ?? ""), text: String(args.text ?? ""), done: args.done === true };
        // The chunk is ephemeral and the UI deletes the streaming bubble on
        // done, so the final text is persisted as a reply FIRST.
        if (chunk.done) {
          const r = await this.channel.push("reply", { space_id: space, content: chunk.text });
          void this.channel.push("reply_chunk", chunk);
          return report(r, "final chunk");
        }
        void this.channel.push("reply_chunk", chunk);
        return { ok: true, text: "chunk sent" };
      }
      default:
        return { ok: false, text: `unknown tool ${tool}` };
    }
  }
}
