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
 *   7. plan, then apply only the actions that are not `unchanged`
 *   8. validate; unparseable output is a failure carrying the raw line
 *   9. record `.suite-stamp.json`, only if its bytes changed
 *
 * Nothing here writes `.suite-state.json`: a stamp stores no secret of its
 * own. The identity in `<root>/suite.json` holds the REF, never the value.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, serializeConfig, writeConfig, emptyConfig, type SuiteConfig } from "./config.ts";
import { assertWritable, gitProbe, type GitProbe, WriteRefused } from "./paths.ts";
import {
  EXIT_FAILED,
  EXIT_REFUSED,
  StampFailure,
  aggregateVerdict,
  divertStdout,
  emptyResult,
  exitCodeFor,
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
  /** Read current state and say what each step would do. Writes nothing. */
  plan(inputs: StampInputs): Promise<StampAction[]>;
  /** Perform every planned action whose outcome is not `unchanged`. */
  apply(inputs: StampInputs, actions: StampAction[]): Promise<void>;
  /** The post-write check. Unparseable output must come back as `unparseable`, never `pass`. */
  validate(inputs: StampInputs): Promise<ValidationVerdict>;
  /** Steps left for a human after a successful stamp, e.g. `start_agent_session`. */
  humanSteps?(inputs: StampInputs): HumanStep[];
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

  const refString = req.tokenRef ?? existing?.tokenRef;
  if (refString === undefined || refString === "") {
    throw refused("token_ref_required", "--token-ref is required (none given and none recorded in suite.json)");
  }
  const keychainService = req.keychainService ?? (req.tokenRef === undefined ? existing?.keychainService : undefined);
  const ref = parseTokenRef(refString, { keychainService });
  result.token_ref = ref.raw;
  validateTokenRef(ref, deps.resolve);

  const suiteUrl = req.suiteUrl ?? existing?.suiteUrl ?? "";
  const runtimeId = req.runtimeId ?? existing?.runtimeId ?? "";
  if (suiteUrl === "") throw refused("suite_url_required", "--suite-url is required (none given and none recorded)");
  if (runtimeId === "") throw refused("runtime_id_required", "--runtime-id is required (none given and none recorded)");
  result.agent.runtime_id = runtimeId;

  const identityNext = serializeConfig(mergeIdentity(existing, ref, suiteUrl, runtimeId));
  const stampPath = join(root, STAMP_FILE);
  const probe = deps.probe ?? gitProbe;
  assertWritable(identityPath, probe);
  assertWritable(stampPath, probe);

  const harnessVersion = await writer.detectVersion();
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

  const identityAction: StampAction = {
    kind: "identity",
    target: identityPath,
    outcome: outcomeFor(identityText, identityNext),
  };
  const planned = await writer.plan(inputs);
  result.actions = [identityAction, ...planned];

  if (identityAction.outcome !== "unchanged") {
    await mkdir(root, { recursive: true });
    await writeConfig(parseConfig(identityNext), { path: identityPath, probe });
  }
  await writer.apply(inputs, planned);
  for (const a of result.actions) io.stderr(`suite: ${a.kind} ${a.target}: ${a.outcome}\n`);

  const verdict = await writer.validate(inputs);
  const aggregated: ValidationVerdict = { verdict: aggregateVerdict(verdict.checks), checks: verdict.checks };
  result.validation = aggregated;
  for (const c of aggregated.checks) {
    if (c.verdict !== "pass") io.stderr(`suite: check ${c.command}: ${c.verdict}${c.raw ? `: ${c.raw}` : ""}\n`);
  }

  const record: StampRecord = {
    harness: writer.harness,
    writerVersion: writer.writerVersion,
    harnessVersion,
    pluginRef: writer.pluginRef,
    inputsDigest: digest,
    tokenRef: ref.raw,
    ...(ref.kind === "keychain" ? { keychainService: ref.service } : {}),
    verdict: aggregated.verdict,
  };
  const recordNext = serializeStampRecord(record);
  const recordAction: StampAction = { kind: "stamp_record", target: stampPath, outcome: outcomeFor(await readText(stampPath), recordNext) };
  if (recordAction.outcome !== "unchanged") await Bun.write(stampPath, recordNext);
  result.actions.push(recordAction);

  result.changed = result.actions.some((a) => a.outcome !== "unchanged");
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
 */
export async function runStamp(
  writer: HarnessWriter,
  build: () => StampRequest | Promise<StampRequest>,
  io: StampIO,
  deps: StampDeps = {},
): Promise<{ result: StampResult; exitCode: StampExitCode; secrets: string[] }> {
  const progress: Progress = { result: emptyResult(writer.harness, writer.writerVersion), secrets: [] };
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
    result.changed = result.actions.some((a) => a.outcome !== "unchanged");
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
