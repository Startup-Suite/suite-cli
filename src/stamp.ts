/**
 * Stamping: make an agent root Suite-ready for one harness, idempotently.
 *
 * suite-cli is the single owner of stamping the OpenClaw and Hermes channels.
 * This module is the part that does not depend on which harness: it owns the
 * identity file, the stamp record, the order of operations and the contract
 * result. Each harness plugs in as a {@link HarnessWriter}.
 *
 * THE WRITER IS VERSIONED. A writer declares the harness versions whose config
 * shape it was measured against. Running against any other version is ONE
 * warning (`config shape unverified for <harness> <ver>`), never a failure —
 * and there is deliberately no drift detection or auto-fix here. Upstream
 * config-shape detection, when it exists, plugs into `measuredHarnessVersions`
 * and the `.suite-stamp.json` record rather than into a writer's body.
 *
 * ORDER, so that a refusal leaves nothing behind:
 *
 *   1. stdin carries nothing              (else exit 2)
 *   2. the root's suite.json names no operator headers (else exit 2; these
 *      plugins cannot forward them)
 *   3. a token ref is given or recorded, and validates by stat/platform
 *   4. suite URL and runtime id are known
 *   5. the harness is present (the writer may install it on its own flag)
 *   6. if the writer needs the token VALUE, resolve it now, into memory —
 *      a locked keychain is exit 3 before any write
 *   7. plan, then apply only the actions that are not `unchanged`; each
 *      action reports whether it was APPLIED, measured, not assumed
 *   8. validate; unparseable output is a failure carrying the raw line
 *   9. record `.suite-stamp.json`, only if its bytes changed — with verdict
 *      `fail` when any step after the first write failed
 *
 * Nothing here writes `.suite-state.json`: a stamp stores no secret of its
 * own. The identity in `<root>/suite.json` holds the REF, never the value.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, readConfig, serializeConfig, writeConfig, emptyConfig, type SuiteConfig } from "./config.ts";
import { assertWritable, gitProbe, type GitProbe, WriteRefused } from "./paths.ts";
import {
  EXIT_FAILED,
  EXIT_REFUSED,
  StampFailure,
  aggregateVerdict,
  changedTheDisk,
  divertStdout,
  emptyResult,
  exitCodeFor,
  planned,
  processIO,
  redact,
  refused,
  renderStampResult,
  type ActionOutcome,
  type HumanStep,
  type StampAction,
  type StampExitCode,
  type StampIO,
  type StampResult,
  type ValidationVerdict,
} from "./stamp_result.ts";
import {
  parseTokenRef,
  probeStdin,
  refuseStdinData,
  resolveTokenRef,
  validateTokenRef,
  type ResolveDeps,
  type StdinState,
  type TokenRef,
} from "./token_ref.ts";

export const IDENTITY_FILE = "suite.json";
export const STAMP_FILE = ".suite-stamp.json";

type Env = Record<string, string | undefined>;

/** What a writer is handed. `tokenValue` is present only if the writer asked for it. */
export interface StampInputs {
  name: string;
  root: string;
  suiteUrl: string;
  runtimeId: string;
  tokenRef: TokenRef;
  /** In memory only. Hand it to a child on a stdin pipe; never argv, env, file or log. */
  tokenValue?: string;
  /** Harness-specific inputs that are NOT secret. Digested into the stamp record. */
  nonSecret: Record<string, unknown>;
  harnessVersion: string;
  env: Env;
}

export interface HarnessWriter {
  harness: string;
  writerVersion: number;
  /** Harness versions whose config shape this writer was measured against. */
  measuredHarnessVersions: readonly string[];
  /** The pinned plugin this writer installs (a commit sha, a package@version). */
  pluginRef: string;
  /** The installed harness version, or null when the harness is absent. */
  detectVersion(): Promise<string | null>;
  /** Whether apply needs the token VALUE. False when the harness resolves the ref itself. */
  needsTokenValue(ref: TokenRef): boolean;
  /** Read current state and say what each step would do. Writes nothing. Build actions with {@link planned}. */
  plan(inputs: StampInputs): Promise<StampAction[]>;
  /**
   * Writes the writer already performed before planning — a harness install
   * run by `detectVersion`. Collected even when detection or planning then
   * fails or refuses, so the result never hides an install that happened.
   */
  performed?(): StampAction[];
  /**
   * Perform every planned action whose outcome is not `unchanged`, setting
   * `applied` on each as it is performed (and, where it can, read back). An
   * action left `applied: false` is reported as not having happened.
   */
  apply(inputs: StampInputs, actions: StampAction[]): Promise<void>;
  /** The post-write check. Unparseable output must come back as `unparseable`, never `pass`. */
  validate(inputs: StampInputs): Promise<ValidationVerdict>;
  /** Steps left for a human after a successful stamp, e.g. `start_agent_session`. */
  humanSteps?(inputs: StampInputs): HumanStep[];
  /**
   * Advisories the writer learned while applying (e.g. a file upstream writes
   * outside the harness home). Collected after `apply`, before `validate`;
   * each becomes one `warnings` entry and one stderr line. Never a value.
   */
  warnings?(inputs: StampInputs): string[];
}

export interface StampRequest {
  root: string;
  name: string;
  suiteUrl?: string;
  runtimeId?: string;
  /** The `--token-ref` string, when given. Otherwise the ref recorded in suite.json is reused. */
  tokenRef?: string;
  keychainService?: string;
  nonSecret?: Record<string, unknown>;
  env?: Env;
  /**
   * The MACHINE connection (`suite init --token-ref`), used only when no
   * `--token-ref` was given and the root records none. Its ref is the default
   * only for the machine's OWN runtime: a root that names a different runtime
   * id is never handed the machine's token.
   */
  machine?: { suiteUrl: string; runtimeId: string; tokenRef: string; keychainService?: string } | null;
}

/**
 * The connection a stamp falls back to when neither the flags nor the root
 * name a token ref: the machine's, for the machine's runtime. Null otherwise.
 */
export function machineFallback(
  req: Pick<StampRequest, "tokenRef" | "runtimeId" | "machine">,
  existing: SuiteConfig | null,
): NonNullable<StampRequest["machine"]> | null {
  const m = req.machine;
  if (m === undefined || m === null || m.tokenRef === "") return null;
  if (req.tokenRef !== undefined || (existing?.tokenRef ?? "") !== "") return null;
  const runtimeId = req.runtimeId ?? existing?.runtimeId;
  if (runtimeId !== undefined && runtimeId !== "" && runtimeId !== m.runtimeId) return null;
  return m;
}

export interface StampDeps {
  resolve?: ResolveDeps;
  /** Stdin state. Defaults to probing the real stdin. */
  stdin?: () => Promise<StdinState>;
  probe?: GitProbe;
}

/** The stamp record, as persisted. Holds refs and a digest, never a value. */
export interface StampRecord {
  harness: string;
  writerVersion: number;
  harnessVersion: string;
  pluginRef: string;
  inputsDigest: string;
  tokenRef: string;
  keychainService?: string;
  verdict: ValidationVerdict["verdict"];
}

/**
 * This machine's ref-mode connection, for {@link StampRequest.machine}. Null
 * when the machine is not connected with a ref, or HOME cannot be resolved.
 */
export async function readMachineConnection(env: Env): Promise<StampRequest["machine"]> {
  let config: SuiteConfig | null;
  try {
    config = await readConfig({ env });
  } catch {
    return null;
  }
  if (config === null || config.tokenRef === undefined || config.tokenRef === "") return null;
  if (config.suiteUrl === "" || config.runtimeId === "") return null;
  return {
    suiteUrl: config.suiteUrl,
    runtimeId: config.runtimeId,
    tokenRef: config.tokenRef,
    ...(config.keychainService !== undefined ? { keychainService: config.keychainService } : {}),
  };
}

/** The warning for a harness version the writer was not measured against. */
export function unverifiedWarning(harness: string, version: string): string {
  return `config shape unverified for ${harness} ${version}`;
}

/** Stable JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 of the NON-secret inputs. The token enters as its ref string only;
 * a different token value behind the same ref digests identically.
 */
export function inputsDigest(inputs: StampInputs, writer: HarnessWriter): string {
  const doc = canonicalJson({
    harness: writer.harness,
    writerVersion: writer.writerVersion,
    suiteUrl: inputs.suiteUrl,
    runtimeId: inputs.runtimeId,
    tokenRef: inputs.tokenRef.raw,
    keychainService: inputs.tokenRef.kind === "keychain" ? inputs.tokenRef.service : undefined,
    nonSecret: inputs.nonSecret,
  });
  if (inputs.tokenValue !== undefined && inputs.tokenValue !== "" && doc.includes(inputs.tokenValue)) {
    throw new StampFailure(EXIT_FAILED, "secret_in_inputs", "a non-secret stamp input carries the token value");
  }
  return `sha256:${createHash("sha256").update(doc).digest("hex")}`;
}

export function serializeStampRecord(record: StampRecord): string {
  const out: Record<string, unknown> = {
    harness: record.harness,
    writerVersion: record.writerVersion,
    harnessVersion: record.harnessVersion,
    pluginRef: record.pluginRef,
    inputsDigest: record.inputsDigest,
    tokenRef: record.tokenRef,
  };
  if (record.keychainService !== undefined) out.keychainService = record.keychainService;
  out.verdict = record.verdict;
  return `${JSON.stringify(out, null, 2)}\n`;
}

export async function readStampRecord(root: string): Promise<StampRecord | null> {
  const file = Bun.file(join(root, STAMP_FILE));
  if (!(await file.exists())) return null;
  try {
    return JSON.parse(await file.text()) as StampRecord;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : null;
}

function outcomeFor(current: string | null, next: string): ActionOutcome {
  if (current === null) return "written";
  return current === next ? "unchanged" : "repaired";
}

/** The identity this run will record, merged over what the root already holds. */
export function mergeIdentity(existing: SuiteConfig | null, ref: TokenRef, suiteUrl: string, runtimeId: string): SuiteConfig {
  const base = existing ?? emptyConfig();
  const next: SuiteConfig = { ...base, suiteUrl, runtimeId, tokenRef: ref.raw };
  if (ref.kind === "keychain") next.keychainService = ref.service;
  else delete next.keychainService;
  return next;
}

interface Progress {
  result: StampResult;
  secrets: string[];
  /** Actions the writer performed before planning (a harness install). */
  performed: StampAction[];
  /** The identity action and the writer's plan, once planning finished. */
  plan: StampAction[] | null;
  /** The stamp record this run would write, minus its verdict; set once the inputs are known. */
  draft: Omit<StampRecord, "verdict"> | null;
  /** True once any write to the root has begun. A failure after this point records `fail`. */
  writesStarted: boolean;
}

/**
 * The actions a result reports, in order: what was performed before planning,
 * then the identity and the plan (each marked applied or not), then the
 * record. Never the plan alone: a failed run must not list writes it did not
 * reach, and a harness install that ran before a refusal must still show.
 */
function reportedActions(progress: Progress, record: StampAction | null): StampAction[] {
  const [identity, ...rest] = progress.plan ?? [];
  return [...(identity !== undefined ? [identity] : []), ...progress.performed, ...rest, ...(record !== null ? [record] : [])];
}

async function writeRecord(stampPath: string, draft: Omit<StampRecord, "verdict">, verdict: StampRecord["verdict"]): Promise<StampAction> {
  const next = serializeStampRecord({ ...draft, verdict });
  const action: StampAction = { kind: "stamp_record", target: stampPath, outcome: outcomeFor(await readText(stampPath), next), applied: false };
  if (action.outcome !== "unchanged") await Bun.write(stampPath, next);
  action.applied = true;
  return action;
}

async function runStampInner(
  writer: HarnessWriter,
  build: () => StampRequest | Promise<StampRequest>,
  io: StampIO,
  deps: StampDeps,
  progress: Progress,
): Promise<void> {
  const { result } = progress;
  refuseStdinData(await (deps.stdin ?? (() => probeStdin()))());

  const req = await build();
  const root = req.root;
  result.agent = { name: req.name, root, runtime_id: req.runtimeId ?? "" };

  const identityPath = join(root, IDENTITY_FILE);
  const identityText = await readText(identityPath);
  let existing: SuiteConfig | null = null;
  if (identityText !== null) {
    try {
      existing = parseConfig(identityText);
    } catch {
      throw refused("identity_unreadable", `${identityPath} is not valid JSON; fix or remove it`);
    }
  }

  if (existing !== null && existing.headerNames.length > 0) {
    throw refused(
      "headers_unsupported",
      `${identityPath} names operator headers (${existing.headerNames.join(", ")}); ` +
        `the ${writer.harness} channel plugin cannot forward extra headers`,
    );
  }

  const machine = machineFallback(req, existing);
  if (machine !== null) {
    io.stderr(`suite: --token-ref defaults to this machine's connection: ${machine.tokenRef} (runtime ${machine.runtimeId})\n`);
  }
  const refString = req.tokenRef ?? (existing?.tokenRef || undefined) ?? machine?.tokenRef;
  if (refString === undefined || refString === "") {
    throw refused("token_ref_required", "--token-ref is required (none given and none recorded in suite.json)");
  }
  const keychainService =
    req.keychainService ??
    (req.tokenRef === undefined ? (machine !== null ? machine.keychainService : existing?.keychainService) : undefined);
  const ref = parseTokenRef(refString, { keychainService });
  result.token_ref = ref.raw;
  validateTokenRef(ref, deps.resolve);

  const suiteUrl = req.suiteUrl ?? (existing?.suiteUrl || undefined) ?? machine?.suiteUrl ?? "";
  const runtimeId = req.runtimeId ?? (existing?.runtimeId || undefined) ?? machine?.runtimeId ?? "";
  if (suiteUrl === "") throw refused("suite_url_required", "--suite-url is required (none given and none recorded)");
  if (runtimeId === "") throw refused("runtime_id_required", "--runtime-id is required (none given and none recorded)");
  result.agent.runtime_id = runtimeId;

  const identityNext = serializeConfig(mergeIdentity(existing, ref, suiteUrl, runtimeId));
  const stampPath = join(root, STAMP_FILE);
  const probe = deps.probe ?? gitProbe;
  assertWritable(identityPath, probe);
  assertWritable(stampPath, probe);

  let harnessVersion: string | null;
  try {
    harnessVersion = await writer.detectVersion();
  } finally {
    progress.performed.push(...(writer.performed?.() ?? []));
  }
  if (harnessVersion === null) {
    throw refused("harness_absent", `${writer.harness} is not installed; pass --install-${writer.harness} to install it`);
  }
  result.harness_version = harnessVersion;
  if (!writer.measuredHarnessVersions.includes(harnessVersion)) {
    const w = unverifiedWarning(writer.harness, harnessVersion);
    result.warnings.push(w);
    io.stderr(`suite: warning: ${w}\n`);
  }

  const inputs: StampInputs = {
    name: req.name,
    root,
    suiteUrl,
    runtimeId,
    tokenRef: ref,
    nonSecret: req.nonSecret ?? {},
    harnessVersion,
    env: req.env ?? process.env,
  };
  if (writer.needsTokenValue(ref)) {
    inputs.tokenValue = await resolveTokenRef(ref, deps.resolve);
    progress.secrets.push(inputs.tokenValue);
  }
  const digest = inputsDigest(inputs, writer);

  const identityAction = planned("identity", identityPath, outcomeFor(identityText, identityNext));
  const actions = await writer.plan(inputs);
  progress.plan = [identityAction, ...actions];
  progress.draft = {
    harness: writer.harness,
    writerVersion: writer.writerVersion,
    harnessVersion,
    pluginRef: writer.pluginRef,
    inputsDigest: digest,
    tokenRef: ref.raw,
    ...(ref.kind === "keychain" ? { keychainService: ref.service } : {}),
  };

  progress.writesStarted = true;
  if (identityAction.outcome !== "unchanged") {
    await mkdir(root, { recursive: true });
    await writeConfig(parseConfig(identityNext), { path: identityPath, probe });
    identityAction.applied = true;
  }
  await writer.apply(inputs, actions);
  for (const a of reportedActions(progress, null)) io.stderr(`suite: ${a.kind} ${a.target}: ${a.outcome}${a.applied ? "" : " (not applied)"}\n`);
  for (const w of writer.warnings?.(inputs) ?? []) {
    const line = redact(w, progress.secrets);
    result.warnings.push(line);
    io.stderr(`suite: warning: ${line}\n`);
  }

  const verdict = await writer.validate(inputs);
  const aggregated: ValidationVerdict = { verdict: aggregateVerdict(verdict.checks), checks: verdict.checks };
  result.validation = aggregated;
  for (const c of aggregated.checks) {
    if (c.verdict !== "pass") io.stderr(`suite: check ${c.command}: ${c.verdict}${c.raw ? `: ${c.raw}` : ""}\n`);
  }

  const recordAction = await writeRecord(stampPath, progress.draft, aggregated.verdict);
  result.actions = reportedActions(progress, recordAction);
  result.changed = result.actions.some(changedTheDisk);
  result.ok = aggregated.verdict === "pass";
  if (!result.ok) {
    result.error = { code: "validation_failed", message: `post-write check for ${writer.harness} did not pass (${aggregated.verdict})` };
  } else {
    result.human_steps.push(...(writer.humanSteps?.(inputs) ?? []));
  }
}

/**
 * Run one stamp and return the result plus its exit code. Writes nothing to
 * stdout; human lines go to `io.stderr`. `build` parses the verb's flags and
 * may throw a {@link StampFailure}, so a refused flag still yields a document.
 *
 * A run that fails AFTER it began writing to the root records `fail` in
 * `.suite-stamp.json`, so an older `pass` cannot outlive it: `suite status`
 * would otherwise report the last good stamp, and `--gateway-only` would
 * launch on a root in an unknown state. A refusal before any write leaves the
 * record, and every other file, as it was.
 */
export async function runStamp(
  writer: HarnessWriter,
  build: () => StampRequest | Promise<StampRequest>,
  io: StampIO,
  deps: StampDeps = {},
): Promise<{ result: StampResult; exitCode: StampExitCode; secrets: string[] }> {
  const progress: Progress = {
    result: emptyResult(writer.harness, writer.writerVersion),
    secrets: [],
    performed: [],
    plan: null,
    draft: null,
    writesStarted: false,
  };
  let failure: StampFailure | null = null;
  try {
    await runStampInner(writer, build, io, deps, progress);
  } catch (e) {
    if (e instanceof StampFailure) failure = e;
    else if (e instanceof WriteRefused) failure = new StampFailure(EXIT_REFUSED, "write_refused", e.message);
    else failure = new StampFailure(EXIT_FAILED, "internal", e instanceof Error ? e.message : String(e));
  }
  const { result } = progress;
  if (failure !== null) {
    result.ok = false;
    result.error = { code: failure.code, message: redact(failure.message, progress.secrets) };
    result.human_steps.push(...failure.humanSteps);
    let record: StampAction | null = null;
    if (progress.writesStarted && progress.draft !== null) {
      try {
        record = await writeRecord(join(result.agent.root, STAMP_FILE), progress.draft, "fail");
      } catch (e) {
        io.stderr(`suite: could not record the failed stamp: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    result.actions = reportedActions(progress, record);
    result.changed = result.actions.some(changedTheDisk);
    for (const a of result.actions) if (!a.applied) io.stderr(`suite: ${a.kind} ${a.target}: ${a.outcome} (not applied)\n`);
    io.stderr(`suite: ${redact(failure.message, progress.secrets)}\n`);
  }
  return { result, exitCode: exitCodeFor(result, failure), secrets: progress.secrets };
}

/**
 * The `--stamp-only` entry point: exactly one JSON document on stdout, every
 * other byte on stderr, and the contract exit code returned for the caller to
 * pass to `process.exit`.
 */
export async function stampCommand(
  writer: HarnessWriter,
  build: () => StampRequest | Promise<StampRequest>,
  deps: StampDeps = {},
  io?: StampIO,
): Promise<StampExitCode> {
  const go = async (sink: StampIO): Promise<StampExitCode> => {
    const { result, exitCode, secrets } = await runStamp(writer, build, sink, deps);
    sink.stdout(renderStampResult(result, secrets));
    return exitCode;
  };
  return io !== undefined ? await go(io) : await divertStdout(go);
}

export { processIO };
