/**
 * `suite init --suite-url URL --runtime-id ID --token-ref REF
 *             [--keychain-service SVC] [--json] [--no-supervisor]`
 *
 * The NON-INTERACTIVE init: what a machine caller (the Mac app) runs to
 * connect this machine without a terminal. The prompt mode (`suite init` with
 * none of these flags) is unchanged; see init.ts.
 *
 * THE TOKEN IS A REF, NEVER A VALUE. `config.json` records `tokenRef` and
 * `keychainService`; `credentials.json` holds NO token in ref mode (operator
 * header values, if any were saved before, are kept as they were). A literal
 * is refused with exit 2 in every spelling — `--token`, `--token=`,
 * `--token-stdin`, a `--token-ref` that is not a ref, and data on stdin —
 * because argv is world-readable through `ps`.
 *
 * NOTHING IS SAVED UNTIL SUITE HAS ACCEPTED THE CREDENTIAL. The ref is
 * resolved IN MEMORY and used for the same authenticated `tools/list` call
 * `suite doctor` makes. A rejected credential and an unreachable URL both exit
 * 1, with distinct `error.code`s (`credential_rejected`, `suite_unreachable`),
 * and leave config.json and credentials.json byte-for-byte as they were.
 *
 * `--json` prints ONE document on stdout and every human line on stderr:
 *
 *   {contract_version: 1, ok, changed,
 *    connection: {suite_url, runtime_id, token_ref, keychain_service},
 *    deps: {bun, tmux}, watchdog, human_steps, error}
 *
 * Exit codes are the stamp contract's (stamp_result.ts): 0 ok, 1 failed,
 * 2 refused, 3 blocked on a human. human_steps kinds: keychain_unlock,
 * keychain_item_missing, install_tmux (install_bun comes from the POSIX
 * launcher, before any TypeScript runs). Each carries the exact command and an
 * official URL. Init runs NO package manager.
 */
import { readFileSync } from "node:fs";
import { emptyConfig, readConfig, serializeConfig, writeConfig, type SuiteConfig } from "../config.ts";
import { credentialsPath, readCredentials, writeCredentials } from "../connection.ts";
import { configPath } from "../paths.ts";
import {
  CONTRACT_VERSION,
  EXIT_BLOCKED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_REFUSED,
  StampFailure,
  divertStdout,
  redact,
  refused,
  type HumanStep,
  type StampIO,
} from "../stamp_result.ts";
import { supervisorPlan, installSupervisor, restoreUnitPlan, writeRestoreUnit, type SupervisorIo } from "../supervisor.ts";
import {
  parseTokenRef,
  probeStdin,
  refuseStdinData,
  resolveTokenRef,
  takeTokenRefFlags,
  validateTokenRef,
  type ResolveDeps,
  type StdinState,
} from "../token_ref.ts";
import { CREDENTIAL_PROBE_TIMEOUT_MS } from "../tuning.ts";
import { row } from "../ui.ts";
import { TOOLS_LIST_BODY, classifyProbe, toolCount, type ProbeRequest, type ProbeResult } from "./doctor.ts";
import { channelWsUrl, toolsHttpUrl, whichBin } from "./init.ts";

type Env = Record<string, string | undefined>;

/** The flags that select the non-interactive init. Any one of them does. */
const NON_INTERACTIVE_FLAGS = [
  "--token-ref",
  "--keychain-service",
  "--suite-url",
  "--runtime-id",
  "--json",
  "--token",
  "--token-stdin",
  "--install-bun",
];

/** True when `suite init` was given any machine flag. Prompt mode otherwise. */
export function isNonInteractiveInit(args: string[]): boolean {
  return args.some((a) => NON_INTERACTIVE_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}

export interface InitRefOptions {
  suiteUrl?: string;
  runtimeId?: string;
  tokenRef?: string;
  keychainService?: string;
  json: boolean;
  noSupervisor: boolean;
}

/** Parse the non-interactive flags. A literal token flag is refused here, before anything else. */
export function parseInitRefOptions(args: string[]): InitRefOptions {
  const { tokenRef, keychainService, rest } = takeTokenRefFlags(args);
  const out: InitRefOptions = { tokenRef, keychainService, json: false, noSupervisor: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === "--json" || flag === "--no-supervisor" || flag === "--install-bun") {
      if (eq > 0) throw refused("flag_takes_no_value", `${flag} takes no value`);
      if (flag === "--json") out.json = true;
      if (flag === "--no-supervisor") out.noSupervisor = true;
      // --install-bun is the launcher's: by the time TypeScript runs, bun is here.
      continue;
    }
    if (flag === "--suite-url" || flag === "--runtime-id" || flag === "--checkout") {
      const value = eq > 0 ? arg.slice(eq + 1) : rest[i + 1];
      if (eq <= 0) i++;
      if (value === undefined || value === "") throw refused("flag_value_missing", `${flag} needs a value`);
      if (flag === "--suite-url") out.suiteUrl = value;
      if (flag === "--runtime-id") out.runtimeId = value;
      continue;
    }
    throw refused(
      "unknown_argument",
      arg.startsWith("--")
        ? `suite init: unknown option ${flag}`
        : "suite init: unexpected positional argument (not repeated here, in case it is a value)",
    );
  }
  return out;
}

export interface DepState {
  present: boolean;
  version: string | null;
  path: string | null;
}

export interface InitRefResult {
  contract_version: typeof CONTRACT_VERSION;
  ok: boolean;
  changed: boolean;
  connection: { suite_url: string; runtime_id: string; token_ref: string | null; keychain_service: string | null };
  deps: { bun: DepState; tmux: DepState };
  watchdog: { requested: boolean; installed: boolean | null; kind: string | null; summary: string | null };
  human_steps: HumanStep[];
  error: { code: string; message: string } | null;
}

/** Field order of the document, pinned by test and named in the README. */
export const INIT_RESULT_FIELDS = [
  "contract_version",
  "ok",
  "changed",
  "connection",
  "deps",
  "watchdog",
  "human_steps",
  "error",
] as const satisfies readonly (keyof InitRefResult)[];

export interface InitRefDeps {
  env: Env;
  platform: NodeJS.Platform;
  resolve?: ResolveDeps;
  stdin?: () => Promise<StdinState>;
  /** ONE authenticated tools/list POST. In-process fetch, never a spawned curl. */
  probe(request: ProbeRequest): Promise<ProbeResult>;
  /** `tmux -V` output, or null when tmux cannot be run. */
  tmuxVersion(path: string): Promise<string | null>;
  bun: DepState;
  /** Absent: the watchdog is not touched (every test). */
  supervisorIo?: SupervisorIo;
}

export const TMUX_INSTALL_URL = "https://github.com/tmux/tmux/wiki/Installing";

/** The command a human runs to install tmux here. Shown, never run. */
export function tmuxInstallCommand(platform: NodeJS.Platform, env: Env): string {
  if (platform === "darwin") return "brew install tmux";
  if (whichBin("apt-get", env) !== null) return "sudo apt-get install -y tmux";
  if (whichBin("dnf", env) !== null) return "sudo dnf install -y tmux";
  if (whichBin("apk", env) !== null) return "sudo apk add tmux";
  return "install tmux with your system's package manager";
}

export function installTmuxStep(platform: NodeJS.Platform, env: Env): HumanStep {
  return {
    kind: "install_tmux",
    text: "tmux is not installed. Agents need it to outlive the app or terminal that started them. Install it, then connect again.",
    command: tmuxInstallCommand(platform, env),
    url: TMUX_INSTALL_URL,
  };
}

function emptyResult(): InitRefResult {
  return {
    contract_version: CONTRACT_VERSION,
    ok: false,
    changed: false,
    connection: { suite_url: "", runtime_id: "", token_ref: null, keychain_service: null },
    deps: { bun: { present: false, version: null, path: null }, tmux: { present: false, version: null, path: null } },
    watchdog: { requested: false, installed: null, kind: null, summary: null },
    human_steps: [],
    error: null,
  };
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** What the probe verdict means for init. `ok` returns null. */
function probeFailure(verdict: ReturnType<typeof classifyProbe> | "unreachable", url: string): StampFailure | null {
  switch (verdict) {
    case "ok":
      return null;
    case "rejected":
      return new StampFailure(EXIT_FAILED, "credential_rejected", `Suite at ${url} rejected the runtime credential the ref names. Nothing was saved.`);
    case "unreachable":
      return new StampFailure(EXIT_FAILED, "suite_unreachable", `Nothing answered at ${url} (DNS, network or URL). Nothing was saved.`);
    case "gateway-challenge":
      return new StampFailure(EXIT_FAILED, "gateway_challenge", `An access gateway in front of ${url} answered instead of Suite. Nothing was saved.`);
    default:
      return new StampFailure(EXIT_FAILED, "suite_response_unreadable", `The response from ${url} was neither a tool list nor a refusal. Nothing was saved.`);
  }
}

/**
 * The run. Returns the document and the exit code; prints nothing on stdout.
 * Human lines go to `io.stderr`. `secrets` is what the renderer redacts.
 */
export async function runInitRefInner(
  args: string[],
  deps: InitRefDeps,
  io: StampIO,
): Promise<{ result: InitRefResult; exitCode: number; secrets: string[] }> {
  const result = emptyResult();
  const secrets: string[] = [];
  try {
    refuseStdinData(await (deps.stdin ?? (() => probeStdin()))());
    const opts = parseInitRefOptions(args);
    if (args.includes("--install-bun") && opts.suiteUrl === undefined && opts.runtimeId === undefined && opts.tokenRef === undefined) {
      // `suite init --install-bun --json` on its own: the launcher has just
      // installed bun (or found it). Report the deps and stop; nothing to save.
      result.deps.bun = deps.bun;
      const tmuxPath = whichBin("tmux", deps.env);
      if (tmuxPath !== null) {
        const v = await deps.tmuxVersion(tmuxPath);
        result.deps.tmux = { present: v !== null, version: v, path: tmuxPath };
      }
      if (!result.deps.tmux.present) result.human_steps.push(installTmuxStep(deps.platform, deps.env));
      result.ok = true;
      return { result, exitCode: EXIT_OK, secrets };
    }
    if (opts.suiteUrl === undefined) throw refused("suite_url_required", "--suite-url URL is required");
    if (opts.runtimeId === undefined) throw refused("runtime_id_required", "--runtime-id ID is required");
    if (opts.tokenRef === undefined) throw refused("token_ref_required", "--token-ref REF is required (keychain:<item> or file:<absolute path>)");
    let toolsUrl: string;
    try {
      channelWsUrl(opts.suiteUrl);
      toolsUrl = toolsHttpUrl(opts.suiteUrl);
    } catch {
      throw refused("suite_url_invalid", `${JSON.stringify(opts.suiteUrl)} is not a Suite URL; paste the https:// address you open in a browser`);
    }
    const ref = parseTokenRef(opts.tokenRef, { keychainService: opts.keychainService });
    result.connection = {
      suite_url: opts.suiteUrl,
      runtime_id: opts.runtimeId,
      token_ref: ref.raw,
      keychain_service: ref.kind === "keychain" ? ref.service : null,
    };
    validateTokenRef(ref, deps.resolve);

    // Dependencies: checked and NAMED, never installed. Blocked before any network.
    result.deps.bun = deps.bun;
    const tmuxPath = whichBin("tmux", deps.env);
    if (tmuxPath !== null) {
      const v = await deps.tmuxVersion(tmuxPath);
      result.deps.tmux = { present: v !== null, version: v, path: tmuxPath };
    }
    if (!result.deps.tmux.present) {
      const step = installTmuxStep(deps.platform, deps.env);
      throw new StampFailure(EXIT_BLOCKED, "tmux_missing", step.text, [step]);
    }

    // The credential, resolved IN MEMORY, then shown to Suite.
    const token = await resolveTokenRef(ref, deps.resolve);
    secrets.push(token);
    const existing = await readConfig({ env: deps.env });
    const saved = readCredentials(deps.env);
    const headerNames = existing?.headerNames ?? [];
    const operatorHeaders: Record<string, string> = {};
    for (const name of headerNames) {
      const v = saved?.headers[name];
      if (v !== undefined && v !== "") {
        operatorHeaders[name] = v;
        secrets.push(v);
      }
    }
    let probe: ProbeResult | null = null;
    try {
      probe = await deps.probe({
        url: toolsUrl,
        headers: {
          ...operatorHeaders,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      });
    } catch {
      probe = null;
    }
    const failure = probeFailure(probe === null ? "unreachable" : classifyProbe(probe), toolsUrl);
    if (failure !== null) throw failure;
    io.stderr(`${row("suite", "credential accepted", `${toolCount(probe?.body ?? "") ?? 0} tools`)}\n`);

    // Write, and say whether anything changed.
    const cfgPath = configPath(deps.env);
    const credPath = credentialsPath(deps.env);
    const beforeCfg = readOrNull(cfgPath);
    const beforeCred = readOrNull(credPath);
    const next: SuiteConfig = {
      ...(existing ?? emptyConfig()),
      suiteUrl: opts.suiteUrl,
      runtimeId: opts.runtimeId,
      headerNames,
      tokenRef: ref.raw,
    };
    if (ref.kind === "keychain") next.keychainService = ref.service;
    else delete next.keychainService;
    delete next.tokenEnv;
    if (beforeCfg !== serializeConfig(next)) await writeConfig(next, { env: deps.env });
    // NO TOKEN in ref mode. The file is only (re)written when it exists (to
    // blank a token an older init saved) or there are operator headers to keep.
    if (beforeCred !== null || Object.keys(operatorHeaders).length > 0) {
      const body = `${JSON.stringify({ token: "", headers: operatorHeaders }, null, 2)}\n`;
      if (beforeCred !== body) writeCredentials(deps.env, { token: "", headers: operatorHeaders });
    }
    result.changed = readOrNull(cfgPath) !== beforeCfg || readOrNull(credPath) !== beforeCred;
    io.stderr(`${row("config", cfgPath, result.changed ? "written" : "unchanged")}\n`);

    // The watchdog, unless declined. Never touched without an io (tests).
    result.watchdog.requested = !opts.noSupervisor;
    if (!opts.noSupervisor && deps.supervisorIo !== undefined) {
      const home = deps.env.HOME ?? "";
      const plan = supervisorPlan({
        platform: deps.platform,
        home,
        binary: `${home}/.local/bin/suite`,
        inheritedPath: deps.env.PATH,
        inheritedLocale: deps.env.LANG ?? deps.env.LC_ALL,
        intervalSeconds: 60,
      });
      const sup = await installSupervisor(deps.supervisorIo, plan);
      result.watchdog = { requested: true, installed: sup.installed, kind: sup.kind, summary: sup.summary };
      const restore = restoreUnitPlan({ platform: deps.platform, home, binary: `${home}/.local/bin/suite`, inheritedPath: deps.env.PATH, intervalSeconds: 60 });
      if (restore) writeRestoreUnit(deps.supervisorIo, restore);
    }
    result.ok = true;
    return { result, exitCode: EXIT_OK, secrets };
  } catch (e) {
    const f = e instanceof StampFailure ? e : new StampFailure(EXIT_FAILED, "internal", e instanceof Error ? e.message : String(e));
    result.ok = false;
    result.error = { code: f.code, message: redact(f.message, secrets) };
    result.human_steps.push(...f.humanSteps);
    io.stderr(`suite: ${redact(f.message, secrets)}\n`);
    return { result, exitCode: f.exitCode === EXIT_REFUSED ? EXIT_REFUSED : f.exitCode, secrets };
  }
}

/** The exact bytes of the document: field order pinned, every secret redacted as a last line. */
export function renderInitRefResult(result: InitRefResult, secrets: readonly string[]): string {
  const ordered: Record<string, unknown> = {};
  for (const key of INIT_RESULT_FIELDS) ordered[key] = result[key];
  return redact(`${JSON.stringify(ordered, null, 2)}\n`, secrets);
}

/** Entry point. `--json`: one document on stdout. Otherwise the human lines alone. */
export async function runInitRef(args: string[], deps: InitRefDeps, io?: StampIO): Promise<number> {
  const json = args.includes("--json");
  const go = async (sink: StampIO): Promise<number> => {
    const { result, exitCode, secrets } = await runInitRefInner(args, deps, sink);
    if (json) sink.stdout(renderInitRefResult(result, secrets));
    else if (result.ok) sink.stdout("this machine is connected.\n");
    return exitCode;
  };
  return io !== undefined ? await go(io) : await divertStdout(go);
}

/** Live dependencies. The watchdog is installed only when `supervisorIo` is passed. */
export function liveInitRefDeps(env: Env, supervisorIo?: SupervisorIo): InitRefDeps {
  return {
    env,
    platform: process.platform,
    bun: { present: true, version: Bun.version, path: process.execPath },
    tmuxVersion: async (path) => {
      const proc = Bun.spawn([path, "-V"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) return null;
      return /\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? out.trim();
    },
    probe: async ({ url, headers }) => {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: TOOLS_LIST_BODY,
        signal: AbortSignal.timeout(CREDENTIAL_PROBE_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.text(), contentType: response.headers.get("content-type") ?? "" };
    },
    ...(supervisorIo !== undefined ? { supervisorIo } : {}),
  };
}

