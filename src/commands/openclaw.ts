/**
 * `suite openclaw` — stamp an OpenClaw agent root Suite-ready through
 * OpenClaw's own non-interactive path, then run its gateway in a persistent
 * tmux session.
 *
 * A sibling of `suite hermes` in shape. The agent owns a ROOT; OpenClaw's
 * state lives under it (`OPENCLAW_STATE_DIR=<root>/.openclaw`,
 * `OPENCLAW_CONFIG_PATH=<root>/.openclaw/openclaw.json`,
 * `OPENCLAW_HOME=<root>`), NEVER `~/.openclaw`; the gateway runs in tmux
 * `suite-<name>` through a `--no-session` relaunch of this CLI.
 *
 * `--stamp-only` is the stage-1 machine contract (src/stamp_result.ts): one
 * JSON document on stdout, exit 0/1/2/3, and no session started. It is THE
 * implementation of "provision the OpenClaw channel for a Suite agent": other
 * tools (core's installer `setup channel` step) call it rather than cloning
 * openclaw-suite-channel and running its install.sh.
 *
 * SIX RULES:
 *
 *  1. UPSTREAM WRITES THE CONFIG. The base config comes from
 *     `openclaw onboard --non-interactive --accept-risk` and every later key
 *     from `openclaw config set`; openclaw.json is never hand-written. The
 *     interactive wizard is never run: no `onboard` without
 *     `--non-interactive`, no `--classic`, no `setup --wizard`, no
 *     `configure`. Current values are read with `openclaw config get --json`.
 *  2. EVERY OpenClaw child is spawned through `spawnHarness` with a
 *     `harnessChildEnv` environment scoped to the root, so no child inherits
 *     the operator's OPENCLAW_* (hive's live gateway is exactly such an
 *     install) or SUITE_*. The foreground gateway gets the same env through
 *     the session exec.
 *  3. THE TOKEN IS NEVER MATERIALISED. The account's `token` is the REF
 *     string (`file:<abs path>` or `keychain:<item>` plus
 *     `tokenKeychainService`); openclaw-suite-channel's resolver reads it
 *     itself. This CLI does not read the runtime token at all.
 *  4. NO DAEMON, EVER. Never `gateway install|start|restart`, never
 *     `--install-daemon`, never `systemctl`: systemd --user is per UID, not
 *     per HOME, so any of them could restart the LIVE openclaw-gateway.service
 *     on a machine that already runs one. The gateway is `gateway run`, in the
 *     foreground, inside tmux.
 *  5. NEVER PORT 18789 BY DEFAULT. That is OpenClaw's default and hive's live
 *     gateway. With no `--gateway-port`, the first free port of 18800 or
 *     above is chosen and persisted as `gateway.port`; a re-run reuses it. An
 *     explicit port that is in use is refused (exit 2).
 *  6. IDEMPOTENT. A re-run with identical inputs makes zero `onboard`, zero
 *     `config set`, zero `plugins install` and zero `npm` calls, and returns
 *     `changed:false`.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { harnessChildEnv, spawnHarness } from "../harness_env.ts";
import { dataDir } from "../paths.ts";
import { assertNoSecretsInArgv, createStore } from "../secrets.ts";
import {
  canonicalJson,
  readStampRecord,
  runStamp,
  stampCommand,
  STAMP_FILE,
  type HarnessWriter,
  type StampDeps,
  type StampInputs,
  type StampRequest,
} from "../stamp.ts";
import {
  EXIT_FAILED,
  EXIT_REFUSED,
  StampFailure,
  redact,
  refused,
  type HumanStep,
  type StampAction,
  type StampIO,
  type ValidationCheck,
  type ValidationVerdict,
} from "../stamp_result.ts";
import {
  parseTokenRef,
  resolveTokenRef,
  takeTokenRefFlags,
  type ResolveDeps,
  type StdinState,
  type TokenRef,
} from "../token_ref.ts";
import type { TmuxDeps } from "../tmux.ts";
import { classifyPullFailure, noGitPrompt, pullRemedyLines } from "./init.ts";
import { recordLaunch, liveRestoreDeps, type RestoreDeps } from "./restore.ts";
import {
  liveDeepseekDeps,
  runInSession,
  runtimeWsUrl,
  selfArgv,
  sessionNameForAgent,
  type DeepseekDeps,
} from "./deepseek.ts";
import { shellJoin } from "./hermes.ts";

type Env = Record<string, string | undefined>;

/* ------------------------------------------------------------------------- */
/* Pins and names                                                             */
/* ------------------------------------------------------------------------- */

/**
 * DEPLOYER: BUMP THIS BEFORE suite-cli MERGES.
 *
 * This is the stage-2 BRANCH TIP of Startup-Suite/openclaw-suite-channel
 * (`task/01a0d8f8-7fcb-7001-9cf4-6edb07e43c8f`, the token-ref resolver),
 * which is NOT merged yet. A squash merge creates a new sha and the branch is
 * then deleted, so this pin would dangle. After that PR squash-merges, replace
 * this value with the squash sha on openclaw-suite-channel main.
 */
export const OPENCLAW_CHANNEL_REF = "b84cb6d976f567f412bbe9f6007ce5c864668f30";
export const OPENCLAW_CHANNEL_REPO = "https://github.com/Startup-Suite/openclaw-suite-channel.git";

/**
 * The OpenClaw release this writer's commands and output shapes were read
 * against: hive's installed CLI, `OpenClaw 2026.9.4 (3a9d69d)`. Measured
 * directly (throwaway OPENCLAW_STATE_DIR): every onboard flag below in
 * `onboard --help`, and the `config get|validate --json`, `plugins doctor
 * --json` and `plugins inspect --json` shapes. Read from source at 3a9d69d:
 * the `plugins install` local-path rules and the gateway's process title.
 */
export const OPENCLAW_VERSION = "2026.9.4";
export const OPENCLAW_PACKAGE = `openclaw@${OPENCLAW_VERSION}`;
export const MEASURED_OPENCLAW_VERSIONS = [OPENCLAW_VERSION] as const;
/** package.json `engines.node` of openclaw@2026.9.4. */
export const OPENCLAW_NODE_FLOOR = ">=24.16.0 <25 || >=26.1.0";

export const WRITER_VERSION = 1;

export const PLUGIN_ID = "startup-suite-channel-plugin";
export const CHANNEL_ID = "startup-suite";

/**
 * The gateway as `ps` shows it. MEASURED on the CLI path: the launcher's
 * entry sets `process.title = "openclaw"`, after which /proc/<pid>/comm reads
 * `openclaw` and the args are overwritten to `openclaw`. READ FROM SOURCE
 * (dist run-*.mjs `runGatewayLoop`, 2026.9.4): `gateway run` then renames the
 * title to `openclaw-gateway` — args `openclaw-gateway`, comm truncated to 15
 * bytes (`openclaw-gatewa`). `looksLikeAgent` matches the args token.
 *
 * NOT `openclaw`: a name that matched the plain CLI would call any short-lived
 * `openclaw config get` in the pane's tree a live gateway.
 */
export const OPENCLAW_GATEWAY_COMM = "openclaw-gateway";

/** OpenClaw's default gateway port, and the one hive's live gateway holds. */
export const LIVE_GATEWAY_PORT = 18789;
/** Where an unflagged stamp starts looking for a free port. */
export const FIRST_STAMP_PORT = 18800;
export const LAST_STAMP_PORT = 18999;

/** The env var onboarding reads the custom provider key from (`--secret-input-mode ref` stores an env ref to it). */
export const MODEL_KEY_ENV = "CUSTOM_API_KEY";

export const MODEL_COMPATIBILITIES = ["openai", "openai-responses", "anthropic"] as const;

/** Gateway-run arguments this verb owns or refuses to pass through. */
const FORBIDDEN_GATEWAY_ARGS = ["--force", "--port", "--dev", "--reset", "--token", "--password", "--password-file"];

/* ------------------------------------------------------------------------- */
/* Options                                                                    */
/* ------------------------------------------------------------------------- */

export interface OpenclawOptions {
  root: string;
  suiteUrl?: string;
  runtimeId?: string;
  tokenRef?: string;
  keychainService?: string;
  modelBaseUrl?: string;
  model?: string;
  modelCompat: string;
  modelApiKeyRef?: string;
  gatewayPort?: number;
  openclaw?: string;
  installOpenclaw: boolean;
  stampOnly: boolean;
  noSession: boolean;
  /** Internal to the session relaunch: run the stamped gateway, stamp nothing. */
  gatewayOnly: boolean;
  /** Everything after `--`, handed to `openclaw gateway run`. */
  rest: string[];
  /** Our own arguments as given, minus `--stamp-only`: the session command. */
  sessionArgs: string[];
}

const VALUE_FLAGS: Record<string, string> = {
  "--root": "root",
  "--suite-url": "suiteUrl",
  "--runtime-id": "runtimeId",
  "--model-base-url": "modelBaseUrl",
  "--model": "model",
  "--model-compat": "modelCompat",
  "--model-api-key-ref": "modelApiKeyRef",
  "--gateway-port": "gatewayPort",
  "--openclaw": "openclaw",
};

const BOOL_FLAGS: Record<string, "installOpenclaw" | "stampOnly" | "noSession" | "gatewayOnly"> = {
  "--install-openclaw": "installOpenclaw",
  "--stamp-only": "stampOnly",
  "--no-session": "noSession",
  "--gateway-only": "gatewayOnly",
};

/**
 * Parse `suite openclaw` options. Throws a {@link StampFailure} (exit 2) for a
 * literal token, an unknown flag or a bad value. Scanning stops at `--`.
 * An unknown argument is never repeated in the message: it may be a value.
 */
export function parseOpenclawOptions(args: string[], cwd: string = process.cwd()): OpenclawOptions {
  const { tokenRef, keychainService, rest } = takeTokenRefFlags(args);
  const raw: Record<string, string> = {};
  const bools = { installOpenclaw: false, stampOnly: false, noSession: false, gatewayOnly: false };
  let gatewayArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--") {
      gatewayArgs = rest.slice(i + 1);
      break;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag in BOOL_FLAGS) {
      if (eq > 0) throw refused("flag_takes_no_value", `${flag} takes no value`);
      bools[BOOL_FLAGS[flag] as keyof typeof bools] = true;
      continue;
    }
    if (flag in VALUE_FLAGS) {
      const value = eq > 0 ? arg.slice(eq + 1) : rest[i + 1];
      if (eq <= 0) i++;
      if (value === undefined || value === "") throw refused("flag_value_missing", `${flag} needs a value`);
      raw[flag] = value;
      continue;
    }
    throw refused(
      "unknown_argument",
      arg.startsWith("--")
        ? `suite openclaw: unknown option ${flag}`
        : "suite openclaw: unexpected positional argument (not repeated here, in case it is a value); gateway arguments go after --",
    );
  }
  const rootArg = raw["--root"];
  if (rootArg === undefined) throw refused("root_required", "--root DIR is required");
  const root = resolve(cwd, rootArg);

  let gatewayPort: number | undefined;
  if (raw["--gateway-port"] !== undefined) {
    const s = raw["--gateway-port"];
    const n = /^[1-9][0-9]*$/.test(s) ? Number.parseInt(s, 10) : Number.NaN;
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      throw refused("gateway_port_invalid", "--gateway-port must be an integer from 1024 to 65535");
    }
    gatewayPort = n;
  }
  const modelCompat = raw["--model-compat"] ?? "openai";
  if (!(MODEL_COMPATIBILITIES as readonly string[]).includes(modelCompat)) {
    throw refused("model_compat_invalid", `--model-compat must be one of ${MODEL_COMPATIBILITIES.join(", ")}`);
  }
  for (const a of gatewayArgs) {
    const flag = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (FORBIDDEN_GATEWAY_ARGS.includes(flag)) {
      throw refused(
        "gateway_arg_refused",
        `${flag} is not passed to \`openclaw gateway run\`: the port is this verb's (--gateway-port), ` +
          "--force kills whatever holds the port (possibly a live gateway), --dev/--reset rewrite state, and " +
          "credential flags would put a secret on argv",
      );
    }
  }

  const sessionArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      sessionArgs.push(...args.slice(i));
      break;
    }
    if (args[i] !== "--stamp-only") sessionArgs.push(args[i] ?? "");
  }

  return {
    root,
    suiteUrl: raw["--suite-url"],
    runtimeId: raw["--runtime-id"],
    tokenRef,
    keychainService,
    modelBaseUrl: raw["--model-base-url"],
    model: raw["--model"],
    modelCompat,
    modelApiKeyRef: raw["--model-api-key-ref"],
    gatewayPort,
    openclaw: raw["--openclaw"],
    ...bools,
    rest: gatewayArgs,
    sessionArgs,
  };
}

/** True when `--stamp-only` appears before any `--`. Decided before parsing, so a refusal still emits JSON. */
export function wantsStampOnly(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "--stamp-only") return true;
  }
  return false;
}

/**
 * OpenClaw's agent-id normalisation (packages/normalization-core agent-id.ts
 * at 3a9d69d), so the binding's `agentId` names the agent onboarding creates.
 * Null when the name has no representable id.
 */
export function normalizeAgentId(value: string): string | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return lower;
  const id = lower
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return id === "" ? null : id;
}

/** The agent's name (the root's directory name) as an OpenClaw agent id and account id. */
export function agentIdForRoot(root: string): string {
  const id = normalizeAgentId(basename(resolve(root)));
  if (id === null) throw refused("agent_name_invalid", `the root's directory name has no valid OpenClaw agent id; rename ${root}`);
  return id;
}

export function stateDirFor(root: string): string {
  return join(root, ".openclaw");
}

export function configPathFor(root: string): string {
  return join(stateDirFor(root), "openclaw.json");
}

export function workspaceFor(root: string): string {
  return join(stateDirFor(root), "workspace");
}

/** Where the channel plugin checkout lives. Shared across agents: it is a program. */
export function channelCheckoutDir(env: Env): string {
  return join(dataDir(env), "openclaw-suite-channel");
}

/** Where `--install-openclaw` puts the pinned CLI. */
export function managedOpenclawDir(env: Env): string {
  return join(dataDir(env), "openclaw");
}

export function managedOpenclawBin(env: Env): string {
  return join(managedOpenclawDir(env), "node_modules", ".bin", "openclaw");
}

/**
 * The environment of every OpenClaw child: the allowlist, plus the three
 * variables that pin OpenClaw's state to this root. The operator's own
 * OPENCLAW_* never survive (harnessChildEnv strips the family).
 */
export function openclawChildEnv(base: Env, root: string, extra: Env = {}): Record<string, string> {
  return harnessChildEnv(base, {
    OPENCLAW_STATE_DIR: stateDirFor(root),
    OPENCLAW_CONFIG_PATH: configPathFor(root),
    OPENCLAW_HOME: root,
    ...extra,
  });
}

/* ------------------------------------------------------------------------- */
/* Pure parsers of measured OpenClaw output                                   */
/* ------------------------------------------------------------------------- */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function firstLine(text: string): string {
  return stripAnsi(text).split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripAnsi(text).trim());
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `openclaw --version`. MEASURED at 2026.9.4: `OpenClaw 2026.9.4 (3a9d69d)`. */
export function parseOpenclawVersion(stdout: string): string {
  const line = firstLine(stdout);
  const m = /OpenClaw\s+v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(line);
  if (m?.[1] !== undefined) return m[1];
  return line === "" ? "unknown" : line;
}

export type ConfigRead = { present: true; value: unknown } | { present: false };

/**
 * `openclaw config get <path> --json`. MEASURED at 2026.9.4:
 *   set       exit 0, stdout is the value as JSON (`18801`, `["a"]`, an object)
 *   unset     exit 1, `{"ok":false,"error":{"message":"Config path is valid but unset: <path>. ..."}}`
 *   unknown   exit 1, message `Unknown config path: <path>. ...` — what
 *             `channels.startup-suite` reads as before the plugin is installed
 *   invalid   exit 1, message `OpenClaw config is invalid: <file>` plus `issues`
 * Unset and unknown are ABSENT; anything else that is not a value throws.
 */
export function parseConfigGet(path: string, exitCode: number, stdout: string, stderr: string): ConfigRead {
  const doc = parseJson(stdout);
  if (exitCode === 0) {
    if (doc === undefined) {
      throw new StampFailure(EXIT_FAILED, "config_get_unparseable", `openclaw config get ${path} --json printed no JSON: ${firstLine(stdout || stderr)}`);
    }
    return { present: true, value: doc };
  }
  const message = isObject(doc) && isObject(doc.error) && typeof doc.error.message === "string" ? doc.error.message : "";
  if (/^Config path is valid but unset:/.test(message) || /^Unknown config path:/.test(message)) return { present: false };
  const issue =
    isObject(doc) && Array.isArray(doc.issues) && isObject(doc.issues[0])
      ? ` (${String(doc.issues[0].path)}: ${String(doc.issues[0].message)})`
      : "";
  throw new StampFailure(
    EXIT_FAILED,
    "config_get_failed",
    `openclaw config get ${path} exited ${exitCode}: ${message === "" ? firstLine(stdout || stderr) : message}${issue}`,
  );
}

/**
 * `openclaw config validate --json`. MEASURED at 2026.9.4:
 *   valid     exit 0, `{"valid":true,"path":...,"warnings":[...]}`
 *   invalid   exit 1, `{"ok":false,...,"valid":false,"path":...,"issues":[...]}`
 */
export function parseConfigValidate(exitCode: number, stdout: string, stderr: string): ValidationCheck {
  const command = "openclaw config validate --json";
  const doc = parseJson(stdout);
  if (!isObject(doc) || typeof doc.valid !== "boolean") {
    return { command, exit_code: exitCode, verdict: "unparseable", raw: firstLine(stdout || stderr) };
  }
  if (doc.valid === true && exitCode === 0) return { command, exit_code: exitCode, verdict: "pass" };
  const issue = Array.isArray(doc.issues) && isObject(doc.issues[0]) ? `${String(doc.issues[0].path)}: ${String(doc.issues[0].message)}` : "";
  const message = isObject(doc.error) && typeof doc.error.message === "string" ? doc.error.message : "valid:false";
  return { command, exit_code: exitCode, verdict: "fail", raw: issue === "" ? message : issue };
}

const mentionsPlugin = (v: unknown): boolean => {
  const s = JSON.stringify(v) ?? "";
  return s.includes(PLUGIN_ID) || s.includes(`"${CHANNEL_ID}"`);
};

/**
 * `openclaw plugins doctor --json`. MEASURED at 2026.9.4 (clean):
 * `{"ok":true,"pluginErrors":[],"diagnostics":[],"sourceShadowing":[],"compatibility":[],"configurationWarnings":[]}`.
 * Fails when not ok, or when any error or diagnostic names this plugin.
 */
export function parsePluginsDoctor(exitCode: number, stdout: string, stderr: string): ValidationCheck {
  const command = "openclaw plugins doctor --json";
  const doc = parseJson(stdout);
  if (!isObject(doc) || typeof doc.ok !== "boolean" || !Array.isArray(doc.pluginErrors)) {
    return { command, exit_code: exitCode, verdict: "unparseable", raw: firstLine(stdout || stderr) };
  }
  const ours = [...(doc.pluginErrors as unknown[]), ...((Array.isArray(doc.diagnostics) ? doc.diagnostics : []) as unknown[])].filter(mentionsPlugin);
  if (!doc.ok || exitCode !== 0 || ours.length > 0) {
    return { command, exit_code: exitCode, verdict: "fail", raw: (JSON.stringify(ours[0] ?? doc.pluginErrors[0] ?? "ok:false") ?? "").slice(0, 300) };
  }
  return { command, exit_code: exitCode, verdict: "pass" };
}

/**
 * `openclaw plugins inspect startup-suite-channel-plugin --json`. MEASURED at
 * 2026.9.4 (absent): `{"ok":false,"error":{"message":"Plugin not found: ..."}}`.
 * Present, READ FROM SOURCE (plugins-inspect-command.ts): `{plugin: PluginRecord,
 * ..., install}` with `plugin.status` one of loaded | disabled | error.
 */
export function parsePluginInspect(exitCode: number, stdout: string, stderr: string): ValidationCheck {
  const command = `openclaw plugins inspect ${PLUGIN_ID} --json`;
  const doc = parseJson(stdout);
  if (isObject(doc) && doc.ok === false) {
    const message = isObject(doc.error) && typeof doc.error.message === "string" ? doc.error.message : "ok:false";
    return { command, exit_code: exitCode, verdict: "fail", raw: message };
  }
  if (!isObject(doc) || !isObject(doc.plugin) || typeof doc.plugin.status !== "string") {
    return { command, exit_code: exitCode, verdict: "unparseable", raw: firstLine(stdout || stderr) };
  }
  const p = doc.plugin;
  if (p.status === "loaded" && p.enabled !== false) return { command, exit_code: exitCode, verdict: "pass" };
  const why = typeof p.error === "string" ? `: ${p.error}` : "";
  return { command, exit_code: exitCode, verdict: "fail", raw: `status ${String(p.status)}${p.enabled === false ? " (disabled)" : ""}${why}` };
}

/** `node --version` against the openclaw@2026.9.4 floor: >=24.16.0 <25 || >=26.1.0. */
export function nodeMeetsFloor(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (m === null) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  if (maj === 24) return min >= 16;
  if (maj === 26) return min >= 1;
  return maj > 26;
}

/* ------------------------------------------------------------------------- */
/* The config this verb manages                                               */
/* ------------------------------------------------------------------------- */

export interface AccountShape {
  url: string;
  runtimeId: string;
  /** The REF string. Never a value. */
  token: string;
  tokenKeychainService?: string;
  autoJoinSpaces: string[];
}

export function desiredAccount(inputs: Pick<StampInputs, "suiteUrl" | "runtimeId" | "tokenRef">): AccountShape {
  const a: AccountShape = {
    url: runtimeWsUrl(inputs.suiteUrl),
    runtimeId: inputs.runtimeId,
    token: inputs.tokenRef.raw,
    autoJoinSpaces: [],
  };
  if (inputs.tokenRef.kind === "keychain") a.tokenKeychainService = inputs.tokenRef.service;
  return a;
}

/**
 * The account as it should be, merged over what is there: keys this verb
 * does not manage (reconnect tunables an operator set) are kept; a
 * `tokenKeychainService` is dropped when the ref is no longer a keychain one.
 */
export function mergedAccount(current: unknown, desired: AccountShape): Record<string, unknown> {
  const base = isObject(current) ? { ...current } : {};
  if (desired.tokenKeychainService === undefined) delete base.tokenKeychainService;
  const out: Record<string, unknown> = { ...base, ...desired };
  if (isObject(current) && Array.isArray(current.autoJoinSpaces)) out.autoJoinSpaces = current.autoJoinSpaces;
  return out;
}

export interface RouteBinding {
  type: "route";
  agentId: string;
  match: { channel: string; accountId: string };
}

export function desiredBinding(agentId: string): RouteBinding {
  return { type: "route", agentId, match: { channel: CHANNEL_ID, accountId: agentId } };
}

const isOurRoute = (b: unknown, accountId: string): boolean =>
  isObject(b) && b.type === "route" && isObject(b.match) && b.match.channel === CHANNEL_ID && b.match.accountId === accountId;

/** Every other binding kept, in place; exactly ONE route for this account. */
export function mergedBindings(current: unknown, agentId: string): unknown[] {
  const list = Array.isArray(current) ? current : [];
  const want = desiredBinding(agentId);
  const out: unknown[] = [];
  let placed = false;
  for (const b of list) {
    if (isOurRoute(b, agentId)) {
      if (!placed) out.push(want);
      placed = true;
    } else out.push(b);
  }
  if (!placed) out.push(want);
  return out;
}

export function mergedAllow(current: unknown): unknown[] {
  const list = Array.isArray(current) ? [...current] : [];
  return list.includes(PLUGIN_ID) ? list : [...list, PLUGIN_ID];
}

/** A config key this verb owns: the path it reads, and the value it wants given what it read. */
interface ManagedKey {
  path: string;
  want(current: unknown): unknown;
}

export function managedKeys(inputs: Pick<StampInputs, "suiteUrl" | "runtimeId" | "tokenRef">, agentId: string): ManagedKey[] {
  const account = desiredAccount(inputs);
  return [
    { path: "plugins.allow", want: mergedAllow },
    { path: `plugins.entries.${PLUGIN_ID}.enabled`, want: () => true },
    { path: `channels.${CHANNEL_ID}.enabled`, want: () => true },
    { path: `channels.${CHANNEL_ID}.dmPolicy`, want: () => "allowlist" },
    { path: `channels.${CHANNEL_ID}.allowFrom`, want: () => ["*"] },
    { path: `channels.${CHANNEL_ID}.accounts.${agentId}`, want: (c) => mergedAccount(c, account) },
    { path: "bindings", want: (c) => mergedBindings(c, agentId) },
  ];
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/* ------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* ------------------------------------------------------------------------- */

export interface OpenclawDeps {
  /** The environment children are built from (through harnessChildEnv). */
  env: Env;
  which(bin: string): string | null;
  stderr(text: string): void;
  /** Channel plugin source. Tests point these at a local fixture repo. */
  channelRepo?: string;
  channelRef?: string;
  /** True when 127.0.0.1:<port> cannot be bound. Defaults to a real bind probe. */
  portInUse?: (port: number) => Promise<boolean>;
  resolve?: ResolveDeps;
  stdin?: () => Promise<StdinState>;
  session: Pick<DeepseekDeps, "isTTY" | "exec" | "stderr">;
  tmux?: TmuxDeps;
  restore?: RestoreDeps;
  self?: string[];
}

/** Can a listener bind 127.0.0.1:<port>? Loopback is what the gateway binds (`--gateway-bind loopback`). */
export async function probePortInUse(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveP) => {
    const srv = createServer();
    srv.once("error", () => resolveP(true));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolveP(false));
    });
  });
}

/* ------------------------------------------------------------------------- */
/* The writer                                                                 */
/* ------------------------------------------------------------------------- */

interface WriterState {
  bin: string | null;
  installedNow: boolean;
  agentId: string | null;
  port: number | null;
  modelKey?: string;
  stampedBefore: boolean;
  warnings: string[];
  secrets: string[];
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveOpenclawBin(opts: OpenclawOptions, deps: Pick<OpenclawDeps, "which" | "env">): string | null {
  if (opts.openclaw !== undefined) {
    if (isAbsolute(opts.openclaw) || opts.openclaw.includes("/")) {
      const p = resolve(opts.openclaw);
      if (!isExecutable(p)) throw refused("openclaw_not_found", `--openclaw ${p} is not an executable file`);
      return p;
    }
    const found = deps.which(opts.openclaw);
    if (found === null) throw refused("openclaw_not_found", `--openclaw ${opts.openclaw} is not on PATH`);
    return found;
  }
  const managed = managedOpenclawBin(deps.env);
  if (isExecutable(managed)) return managed;
  return deps.which("openclaw");
}

const CHECKOUT_MARKER = ".suite-cli-deps-ref";

export function openclawWriter(ctx: { opts: OpenclawOptions | null }, deps: OpenclawDeps): HarnessWriter & { state: WriterState } {
  const state: WriterState = {
    bin: null,
    installedNow: false,
    agentId: null,
    port: null,
    stampedBefore: false,
    warnings: [],
    secrets: [],
  };
  const opts = (): OpenclawOptions => {
    if (ctx.opts === null) throw new Error("openclaw writer used before its options were parsed");
    return ctx.opts;
  };
  const channelRef = deps.channelRef ?? OPENCLAW_CHANNEL_REF;
  const channelRepo = deps.channelRepo ?? OPENCLAW_CHANNEL_REPO;
  const checkout = (): string => channelCheckoutDir(deps.env);
  const portInUse = deps.portInUse ?? probePortInUse;
  const fail = (code: string, message: string): StampFailure => new StampFailure(EXIT_FAILED, code, redact(message, state.secrets));

  const spawn = async (argv: string[], extra: { cwd?: string; env?: Record<string, string>; secretEnv?: Record<string, string> } = {}) =>
    await spawnHarness(argv, {
      cwd: extra.cwd,
      env: extra.env ?? openclawChildEnv(deps.env, opts().root),
      secretEnv: extra.secretEnv,
      secrets: state.secrets,
    });
  // No mkdir here: plan() reads through this too, and a refusal must leave nothing behind.
  const oc = async (args: string[], extra: { secretEnv?: Record<string, string> } = {}) =>
    await spawn([state.bin as string, ...args], { ...extra, cwd: existsSync(opts().root) ? opts().root : undefined });
  const gitEnv = (): Record<string, string> =>
    noGitPrompt(
      harnessChildEnv(deps.env, { SSH_AUTH_SOCK: deps.env.SSH_AUTH_SOCK, GIT_SSH_COMMAND: deps.env.GIT_SSH_COMMAND }),
    ) as Record<string, string>;

  async function configGet(path: string): Promise<ConfigRead> {
    const r = await oc(["config", "get", path, "--json"]);
    return parseConfigGet(path, r.exitCode, r.stdout, r.stderr);
  }
  const valueOf = (r: ConfigRead): unknown => (r.present ? r.value : undefined);

  async function configSet(path: string, value: unknown): Promise<void> {
    const r = await oc(["config", "set", path, JSON.stringify(value), "--strict-json"]);
    if (r.exitCode !== 0) throw fail("config_set_failed", `openclaw config set ${path} exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
  }

  async function installOpenclaw(): Promise<void> {
    const node = deps.which("node");
    if (node === null) {
      throw refused("node_missing", `--install-openclaw needs node ${OPENCLAW_NODE_FLOOR} on PATH (${OPENCLAW_PACKAGE} declares it)`);
    }
    const v = await spawn([node, "--version"], { env: harnessChildEnv(deps.env) });
    const version = v.stdout.trim();
    if (v.exitCode !== 0 || !nodeMeetsFloor(version)) {
      throw refused("node_too_old", `${OPENCLAW_PACKAGE} needs node ${OPENCLAW_NODE_FLOOR}; ${node} is ${version === "" ? "unreadable" : version}`);
    }
    const npm = deps.which("npm");
    if (npm === null) throw refused("npm_missing", "--install-openclaw needs npm on PATH");
    const dir = managedOpenclawDir(deps.env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(join(dir, "package.json"))) {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "suite-openclaw", private: true }, null, 2)}\n`);
    }
    deps.stderr(`suite: installing ${OPENCLAW_PACKAGE} into ${dir} (pinned; nothing global)\n`);
    const r = await spawn([npm, "install", "--prefix", dir, "--no-audit", "--no-fund", "--save-exact", OPENCLAW_PACKAGE], {
      cwd: dir,
      env: harnessChildEnv(deps.env),
    });
    if (r.exitCode !== 0) throw fail("openclaw_install_failed", `npm install ${OPENCLAW_PACKAGE} exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
    state.installedNow = true;
  }

  async function gitHead(): Promise<string | null> {
    if (!existsSync(join(checkout(), ".git"))) return null;
    const r = await spawn(["git", "-C", checkout(), "rev-parse", "HEAD"], { env: gitEnv(), cwd: dirname(checkout()) });
    return r.exitCode === 0 ? r.stdout.trim() : "";
  }

  async function ensureCheckout(): Promise<void> {
    const dir = checkout();
    const env = gitEnv();
    const cwd = dirname(dir);
    mkdirSync(cwd, { recursive: true });
    if (!existsSync(join(dir, ".git"))) {
      const r = await spawn(["git", "clone", "--quiet", channelRepo, dir], { env, cwd });
      if (r.exitCode !== 0) throw fail("plugin_clone_failed", `git clone ${channelRepo} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const has = await spawn(["git", "-C", dir, "cat-file", "-e", `${channelRef}^{commit}`], { env, cwd });
    if (has.exitCode !== 0) {
      const f = await spawn(["git", "-C", dir, "fetch", "--quiet", "origin"], { env, cwd });
      if (f.exitCode !== 0) {
        const detail = f.stderr || f.stdout;
        throw fail(
          "plugin_fetch_failed",
          [`the plugin checkout at ${dir} could not fetch ${channelRef}:`, detail.trim(), ...pullRemedyLines(classifyPullFailure(detail), dir)].join("\n"),
        );
      }
    }
    const co = await spawn(["git", "-C", dir, "checkout", "--quiet", "--detach", channelRef], { env, cwd });
    if (co.exitCode !== 0) throw fail("plugin_checkout_failed", `git checkout ${channelRef} in ${dir} failed: ${co.stderr.trim()}`);
  }

  function depsMarker(): string | null {
    const p = join(checkout(), "node_modules", CHECKOUT_MARKER);
    return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
  }

  async function installPluginDeps(): Promise<void> {
    const npm = deps.which("npm");
    if (npm === null) throw refused("npm_missing", "the OpenClaw channel plugin's dependencies need npm on PATH");
    // `npm ci`: exactly the plugin's lockfile, so the pin covers its dependencies too.
    const r = await spawn([npm, "ci", "--no-audit", "--no-fund"], { cwd: checkout(), env: harnessChildEnv(deps.env) });
    if (r.exitCode !== 0) throw fail("plugin_deps_failed", `npm ci in ${checkout()} exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
    writeFileSync(join(checkout(), "node_modules", CHECKOUT_MARKER), `${channelRef}\n`);
  }

  async function linkedPaths(): Promise<string[]> {
    const v = valueOf(await configGet("plugins.load.paths"));
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
  }

  /** The port this stamp uses, and whether it differs from what is configured. */
  async function choosePort(configured: number | undefined): Promise<number> {
    const o = opts();
    if (o.gatewayPort !== undefined) {
      // The configured port may be held by THIS agent's own gateway; only a
      // port this stamp would newly adopt is probed.
      if (o.gatewayPort !== configured && (await portInUse(o.gatewayPort))) {
        throw refused(
          "port_in_use",
          `--gateway-port ${o.gatewayPort} is in use on 127.0.0.1${o.gatewayPort === LIVE_GATEWAY_PORT ? " (OpenClaw's default, and a live gateway's)" : ""}; pick another or omit the flag`,
        );
      }
      return o.gatewayPort;
    }
    if (configured !== undefined) return configured;
    for (let p = FIRST_STAMP_PORT; p <= LAST_STAMP_PORT; p++) {
      if (p === LIVE_GATEWAY_PORT) continue;
      if (!(await portInUse(p))) return p;
    }
    throw refused("port_in_use", `no free port from ${FIRST_STAMP_PORT} to ${LAST_STAMP_PORT} on 127.0.0.1; pass --gateway-port`);
  }

  function onboardArgv(port: number): string[] {
    const o = opts();
    return [
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--mode",
      "local",
      "--auth-choice",
      "custom-api-key",
      "--custom-base-url",
      o.modelBaseUrl ?? "",
      "--custom-model-id",
      o.model ?? "",
      "--custom-compatibility",
      o.modelCompat,
      "--secret-input-mode",
      "ref",
      "--gateway-bind",
      "loopback",
      "--gateway-port",
      String(port),
      "--workspace",
      workspaceFor(o.root),
      "--agent-name",
      state.agentId as string,
      "--skip-daemon",
      "--skip-health",
      "--skip-channels",
      "--skip-skills",
      "--skip-bootstrap",
      "--json",
    ];
  }

  const writer: HarnessWriter & { state: WriterState } = {
    state,
    harness: "openclaw",
    writerVersion: WRITER_VERSION,
    measuredHarnessVersions: MEASURED_OPENCLAW_VERSIONS,
    pluginRef: channelRef,

    async detectVersion() {
      const o = opts();
      let bin = resolveOpenclawBin(o, deps);
      if (bin === null && o.installOpenclaw) {
        await installOpenclaw();
        bin = resolveOpenclawBin(o, deps);
        if (bin === null) throw fail("openclaw_install_failed", `npm finished but ${managedOpenclawBin(deps.env)} is not executable`);
      }
      if (bin === null) return null;
      state.bin = bin;
      const r = await spawn([bin, "--version"]);
      if (r.exitCode !== 0) throw fail("harness_broken", `${bin} --version exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
      return parseOpenclawVersion(r.stdout);
    },

    needsTokenValue(_ref: TokenRef) {
      // The plugin resolves both file: and keychain: refs itself (stage 2):
      // this CLI never reads the runtime token.
      return false;
    },

    async plan(inputs) {
      const o = opts();
      state.agentId = agentIdForRoot(o.root);
      state.stampedBefore = (await readStampRecord(o.root)) !== null;
      const absent = state.stampedBefore ? "repaired" : "written";
      const actions: StampAction[] = [];
      if (state.installedNow) {
        actions.push({ kind: "harness_install", target: `${managedOpenclawDir(deps.env)}@${OPENCLAW_PACKAGE}`, outcome: "written" });
      }

      if (o.modelApiKeyRef !== undefined) {
        const ref = parseTokenRef(o.modelApiKeyRef, { keychainService: o.keychainService });
        state.modelKey = await resolveTokenRef(ref, deps.resolve);
        state.secrets.push(state.modelKey);
      }

      const mode = await configGet("gateway.mode");
      const agent = await configGet(`agents.entries.${state.agentId}`);
      const needsOnboard = !mode.present || !agent.present;
      actions.push({ kind: "base_config", target: `${configPathFor(o.root)} (openclaw onboard --non-interactive)`, outcome: needsOnboard ? absent : "unchanged" });

      const portRead = valueOf(await configGet("gateway.port"));
      const configured = typeof portRead === "number" ? portRead : undefined;
      const port = await choosePort(configured);
      state.port = port;
      actions.push({
        kind: "gateway_port",
        target: `gateway.port=${port}`,
        outcome: configured === undefined ? absent : configured === port ? "unchanged" : "repaired",
      });

      const head = await gitHead();
      actions.push({
        kind: "plugin_checkout",
        target: `${checkout()}@${channelRef}`,
        outcome: head === null ? "written" : head === channelRef ? "unchanged" : "repaired",
      });
      const marker = depsMarker();
      actions.push({
        kind: "plugin_deps",
        target: `${join(checkout(), "node_modules")} (npm ci)`,
        outcome: marker === null ? "written" : marker === channelRef && head === channelRef ? "unchanged" : "repaired",
      });
      const linked = (await linkedPaths()).includes(checkout());
      actions.push({ kind: "plugin_link", target: `plugins.load.paths += ${checkout()} (openclaw plugins install --link)`, outcome: linked ? "unchanged" : absent });

      for (const key of managedKeys(inputs, state.agentId)) {
        const current = await configGet(key.path);
        const cur = valueOf(current);
        actions.push({
          kind: "config_set",
          target: key.path,
          outcome: !current.present ? absent : same(cur, key.want(cur)) ? "unchanged" : "repaired",
        });
      }
      return actions;
    },

    async apply(inputs, actions) {
      const o = opts();
      const port = state.port as number;
      const agentId = state.agentId as string;
      const outcomeOf = (kind: string): string | undefined => actions.find((a) => a.kind === kind)?.outcome;
      mkdirSync(stateDirFor(o.root), { recursive: true, mode: 0o700 });

      if (outcomeOf("base_config") !== "unchanged") {
        const r = await oc(onboardArgv(port), {
          secretEnv: state.modelKey !== undefined ? { [MODEL_KEY_ENV]: state.modelKey } : undefined,
        });
        if (r.exitCode !== 0) {
          throw fail("onboard_failed", `openclaw onboard --non-interactive exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
        }
        const agent = await configGet(`agents.entries.${agentId}`);
        if (!agent.present) {
          throw fail("onboard_ineffective", `openclaw onboard exited 0 but agents.entries.${agentId} is unset; the binding would name no agent`);
        }
      }
      const portNow = valueOf(await configGet("gateway.port"));
      if (portNow !== port) await configSet("gateway.port", port);

      const co = outcomeOf("plugin_checkout");
      const depsOutcome = outcomeOf("plugin_deps");
      if (co !== "unchanged") await ensureCheckout();
      if (depsOutcome !== "unchanged" || co !== "unchanged") await installPluginDeps();

      if (!(await linkedPaths()).includes(checkout())) {
        // --link, not a copy: a copy install of a TypeScript entry needs a
        // built ./dist/index.js (package-entry-resolution.ts at 3a9d69d), and
        // this plugin ships none; a link sets allowSourceTypeScriptEntries.
        // --force acknowledges a non-ClawHub source, which a non-TTY run
        // cannot confirm; --accept-capabilities is the consent onboarding
        // cannot give.
        const r = await oc(["plugins", "install", "--link", checkout(), "--force", "--accept-capabilities"]);
        if (r.exitCode !== 0) {
          throw fail("plugin_install_failed", `openclaw plugins install --link ${checkout()} exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
        }
      }

      for (const key of managedKeys(inputs, agentId)) {
        const cur = valueOf(await configGet(key.path));
        const want = key.want(cur);
        if (!same(cur, want)) await configSet(key.path, want);
      }
      for (const key of managedKeys(inputs, agentId)) {
        const cur = valueOf(await configGet(key.path));
        if (!same(cur, key.want(cur))) {
          throw fail("config_set_ineffective", `openclaw config set ${key.path} exited 0 but config get does not return the value`);
        }
      }

      if (state.modelKey !== undefined) {
        state.warnings.push(
          `the model API key is not stored: openclaw.json holds an env ref to ${MODEL_KEY_ENV}, and \`suite openclaw\` resolves ` +
            `--model-api-key-ref into the gateway's environment at each launch, where same-user processes can read it`,
        );
      }
    },

    async validate() {
      const cv = await oc(["config", "validate", "--json"]);
      const pd = await oc(["plugins", "doctor", "--json"]);
      const pi = await oc(["plugins", "inspect", PLUGIN_ID, "--json"]);
      const checks = [
        parseConfigValidate(cv.exitCode, cv.stdout, cv.stderr),
        parsePluginsDoctor(pd.exitCode, pd.stdout, pd.stderr),
        parsePluginInspect(pi.exitCode, pi.stdout, pi.stderr),
      ];
      for (const c of checks) if (c.raw !== undefined) c.raw = redact(c.raw, state.secrets);
      const verdict: ValidationVerdict = { verdict: "pass", checks };
      return verdict;
    },

    humanSteps(): HumanStep[] {
      return [{ kind: "start_agent_session", text: shellJoin(["suite", "openclaw", ...opts().sessionArgs]) }];
    },

    warnings() {
      return state.warnings;
    },
  };
  return writer;
}

/* ------------------------------------------------------------------------- */
/* Running                                                                    */
/* ------------------------------------------------------------------------- */

function stampRequest(opts: OpenclawOptions): StampRequest {
  if (opts.modelBaseUrl === undefined) throw refused("model_base_url_required", "--model-base-url URL is required");
  if (opts.model === undefined) throw refused("model_required", "--model ID is required");
  return {
    root: opts.root,
    name: basename(opts.root),
    suiteUrl: opts.suiteUrl,
    runtimeId: opts.runtimeId,
    tokenRef: opts.tokenRef,
    keychainService: opts.keychainService,
    nonSecret: {
      modelBaseUrl: opts.modelBaseUrl,
      model: opts.model,
      modelCompat: opts.modelCompat,
      modelApiKeyRef: opts.modelApiKeyRef,
      gatewayPort: opts.gatewayPort,
      openclaw: opts.openclaw,
    },
  };
}

/** `openclaw gateway run --port N` plus the operator's arguments. Never install/start/restart. */
export function gatewayArgv(bin: string, port: number, rest: string[]): string[] {
  return [bin, "gateway", "run", "--port", String(port), ...rest];
}

/** The tmux relaunch: this CLI again, gateway only, no session. Carries refs, never a value. */
export function relaunchArgv(self: string[], opts: OpenclawOptions, bin: string, port: number): string[] {
  return [
    ...self,
    "openclaw",
    "--root",
    opts.root,
    "--gateway-only",
    "--no-session",
    "--openclaw",
    bin,
    "--gateway-port",
    String(port),
    ...(opts.modelApiKeyRef !== undefined ? ["--model-api-key-ref", opts.modelApiKeyRef] : []),
    ...(opts.modelApiKeyRef !== undefined && opts.keychainService !== undefined ? ["--keychain-service", opts.keychainService] : []),
    "--",
    ...opts.rest,
  ];
}

/** The gateway's environment: the root-scoped allowlist, plus the model key when one is configured. */
export function gatewayEnv(deps: Pick<OpenclawDeps, "env">, opts: OpenclawOptions, modelKey?: string): Record<string, string> {
  return openclawChildEnv(deps.env, opts.root, modelKey !== undefined ? { [MODEL_KEY_ENV]: modelKey } : {});
}

async function execGateway(opts: OpenclawOptions, deps: OpenclawDeps, bin: string, port: number): Promise<number> {
  const portInUse = deps.portInUse ?? probePortInUse;
  if (await portInUse(port)) {
    deps.stderr(
      `suite: 127.0.0.1:${port} is already in use; is this agent's gateway already running outside its session? Not starting a second one.\n`,
    );
    return EXIT_REFUSED;
  }
  let modelKey: string | undefined;
  if (opts.modelApiKeyRef !== undefined) {
    modelKey = await resolveTokenRef(parseTokenRef(opts.modelApiKeyRef, { keychainService: opts.keychainService }), deps.resolve);
  }
  const argv = gatewayArgv(bin, port, opts.rest);
  const store = createStore();
  if (modelKey !== undefined) store.set("model-key", modelKey);
  assertNoSecretsInArgv(argv, store);
  return await deps.session.exec(argv, { cwd: opts.root, env: gatewayEnv(deps, opts, modelKey) });
}

async function runGateway(opts: OpenclawOptions, deps: OpenclawDeps): Promise<number> {
  const record = await readStampRecord(opts.root);
  if (record === null || record.harness !== "openclaw" || record.verdict !== "pass") {
    deps.stderr(`suite: ${join(opts.root, STAMP_FILE)} records no passing openclaw stamp; run suite openclaw without --gateway-only first\n`);
    return EXIT_REFUSED;
  }
  const bin = resolveOpenclawBin(opts, deps);
  if (bin === null) {
    deps.stderr("suite: openclaw is not installed; pass --openclaw BIN\n");
    return EXIT_REFUSED;
  }
  if (opts.gatewayPort === undefined) {
    deps.stderr("suite: --gateway-only needs --gateway-port (the relaunch always passes it)\n");
    return EXIT_REFUSED;
  }
  return await execGateway(opts, deps, bin, opts.gatewayPort);
}

function stampParts(args: string[], deps: OpenclawDeps) {
  const ctx: { opts: OpenclawOptions | null } = { opts: null };
  const writer = openclawWriter(ctx, deps);
  const build = (): StampRequest => {
    ctx.opts = parseOpenclawOptions(args);
    return stampRequest(ctx.opts);
  };
  const stampDeps: StampDeps = { resolve: deps.resolve, stdin: deps.stdin };
  return { writer, build, stampDeps };
}

/** One stamp, in process, with the human lines going to `io.stderr`. Writes nothing to stdout. */
export async function stampOpenclaw(args: string[], deps: OpenclawDeps, io: StampIO) {
  const { writer, build, stampDeps } = stampParts(args, deps);
  const out = await runStamp(writer, build, io, stampDeps);
  return { ...out, writer };
}

/**
 * Run the verb. Returns the process exit code.
 *
 * `--stamp-only`: the machine contract, nothing else.
 * `--gateway-only` (the relaunch inside tmux): exec `openclaw gateway run`.
 * Otherwise: stamp (human lines on stderr), then start or attach to the
 * `suite-<name>` session — or, with `--no-session`, run the gateway in the
 * foreground.
 */
export async function runOpenclaw(args: string[], deps: OpenclawDeps): Promise<number> {
  if (wantsStampOnly(args)) {
    const { writer, build, stampDeps } = stampParts(args, deps);
    return await stampCommand(writer, build, stampDeps);
  }

  let opts: OpenclawOptions;
  try {
    opts = parseOpenclawOptions(args);
  } catch (e) {
    if (e instanceof StampFailure) {
      deps.stderr(`suite: ${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
  if (opts.gatewayOnly) return await runGateway(opts, deps);

  const { exitCode, writer } = await stampOpenclaw(args, deps, { stdout: () => {}, stderr: deps.stderr });
  if (exitCode !== 0) return exitCode;
  const bin = writer.state.bin as string;
  const port = writer.state.port as number;

  if (opts.noSession) return await execGateway(opts, deps, bin, port);

  const session = sessionNameForAgent(basename(opts.root));
  const relaunch = relaunchArgv(deps.self ?? selfArgv(deps.env as NodeJS.ProcessEnv), opts, bin, port);
  const home = deps.env.HOME ?? "";
  // TMUX is not on the child allowlist, but the nesting decision reads it.
  const sessionEnv = openclawChildEnv(deps.env, opts.root, { TMUX: deps.env.TMUX });
  return await runInSession(session, relaunch, opts.root, sessionEnv, createStore(), deps.session, {
    agentName: OPENCLAW_GATEWAY_COMM,
    tmux: deps.tmux,
    onCreated: (createArgv) => {
      if (deps.restore) recordLaunch(deps.restore, home, { session, command: createArgv, cwd: opts.root, kind: "openclaw" });
    },
  });
}

export function liveOpenclawDeps(): OpenclawDeps {
  return {
    env: process.env,
    which: (bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }),
    stderr: (t) => void process.stderr.write(t),
    session: liveDeepseekDeps(),
    restore: liveRestoreDeps(),
  };
}
