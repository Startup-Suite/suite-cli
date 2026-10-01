/**
 * `suite hermes` — stamp a Hermes Agent root Suite-ready, then run its gateway
 * in a persistent tmux session.
 *
 * A sibling of `suite deepseek` in shape: an agent owns a ROOT, the harness
 * state lives under it (`HERMES_HOME` defaults to `<root>/.hermes`, NEVER
 * `~/.hermes`), and the long-lived process runs in tmux `suite-<name>` through
 * a `--no-session` relaunch of this CLI.
 *
 * `--stamp-only` is the stage-1 machine contract (src/stamp_result.ts): one
 * JSON document on stdout, exit 0/1/2/3, and no session started.
 *
 * WHAT THIS VERB OWNS, AND WHAT IT DOES NOT. The Startup Suite channel for
 * Hermes is installed by THAT plugin's own `install.sh`, pinned at
 * {@link HERMES_CHANNEL_REF}. The installer owns the 0600 token file, the
 * `.env` keys, the plugin install/enable and the stdio `mcp_servers` bridge;
 * none of it is reimplemented here. This verb owns only what the installer
 * does not: the harness binary (optionally), the mcp SDK in the managed env,
 * and the model block of config.yaml.
 *
 * FIVE RULES:
 *
 *  1. EVERY Hermes-side child is spawned through `spawnHarness` with a
 *     `harnessChildEnv` environment, so no child inherits SUITE_* / HERMES_* /
 *     OPENCLAW_* and an argv carrying a known secret throws before the child
 *     exists. The one exception is the foreground gateway (`gateway run`),
 *     which needs the terminal's stdio; it gets the same `harnessChildEnv` and
 *     the same argv check, but through the session exec.
 *  2. THE TOKEN. A `file:` ref is passed to the installer as `--token-file
 *     <path>`: the value never enters this process. A `keychain:` ref is
 *     resolved in memory and written to the installer's STDIN pipe. The
 *     installer then holds it in `$HERMES_HOME/mcp-tokens/...runtime-token`,
 *     mode 0600 — the one sanctioned copy, recorded as its own action. The
 *     Hermes plugin has no keychain resolver yet (follow-up).
 *  3. config.yaml IS READ BY PARSING IT, never with `hermes config get --raw`,
 *     which expands `${VAR}` from the environment. Writes go through
 *     `hermes config set`, and only for keys whose value differs.
 *  4. NEVER `hermes setup` (its --non-interactive only prints guidance), and
 *     NEVER `hermes gateway start|restart|install` (they install systemd
 *     units; systemd --user is per UID, not per HOME).
 *  5. IDEMPOTENT. A re-run with identical inputs makes zero `config set`
 *     calls, finds the installer reporting "already", and returns
 *     `changed:false`. The installer's own outcomes are MEASURED (a
 *     fingerprint of each file it owns, before and after), not predicted.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";

// `yaml` is loaded lazily, on the first config.yaml read. cli.ts imports every
// command module at startup, so a top-level import made EVERY verb (`suite
// claude` included) fail with "ENOENT while resolving package 'yaml'" on an
// install whose dependencies were not installed. Only the hermes verb needs it.
const requireLazy = createRequire(import.meta.url);
function parseYaml(text: string): unknown {
  const { parse } = requireLazy("yaml") as { parse: (t: string) => unknown };
  return parse(text);
}
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
  planned,
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
import { loadRoster, recordLaunch, liveRestoreDeps, type RestoreDeps } from "./restore.ts";
import {
  liveDeepseekDeps,
  runInSession,
  runtimeWsUrl,
  selfArgv,
  sessionNameForAgent,
  type DeepseekDeps,
} from "./deepseek.ts";

type Env = Record<string, string | undefined>;

/* ------------------------------------------------------------------------- */
/* Pins and names                                                             */
/* ------------------------------------------------------------------------- */

/**
 * DEPLOYER: BUMP THIS BEFORE suite-cli MERGES.
 *
 * This is the SQUASH sha on Startup-Suite/hermes-suite-channel main of PR #3
 * (the stage-6 #!/bin/sh launcher fix and `--python`, task 01a0d8f8), bumped
 * at deploy from the pre-merge branch tip 61e8b603. This verb always passes
 * `--python`, which installers before this commit refuse, so the pin cannot
 * move to an older commit. Pin a commit on main, never a branch tip: a squash
 * merge deletes the branch and the tip would dangle.
 */
export const HERMES_CHANNEL_REF = "d9918533f0b4c5f2035ed98803fd7906030bd1bf";
export const HERMES_CHANNEL_REPO = "https://github.com/Startup-Suite/hermes-suite-channel.git";

/** The hermes-agent commit the config shape below was measured against. */
export const HERMES_AGENT_REF = "fdec926ef54391edcf6caad5f7f6761fdcccdaa2";
export const HERMES_INSTALLER_URL = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_AGENT_REF}/scripts/install.sh`;

/**
 * The harness version this writer reports is the LOCAL commit of the install,
 * 8 hex characters: the one its config shape was measured against.
 */
export const MEASURED_HERMES_VERSIONS = [HERMES_AGENT_REF.slice(0, 8)] as const;

export const WRITER_VERSION = 1;

/**
 * The measured version of the MCP SDK Hermes's MCP client needs. At
 * fdec926e the deps are declared only for python >= 3.14, so a 3.12 env gets
 * none of them.
 */
export const MCP_SDK_PIN = "mcp==2.0.0";

export const MCP_SERVER_NAME = "startup-suite";
export const PLUGIN_NAME = "startup-suite-platform";
export const TOKEN_RELPATH = join("mcp-tokens", "startup-suite-platform.runtime-token");
/** The channel installer's last stdout line on success. */
export const INSTALLER_RESULT_LINE = "hermes-suite-channel: installed";

/**
 * The gateway's program name as `ps` reports it. MEASURED: hermes_cli/main.py
 * `_set_process_title` sets PR_SET_NAME to `hermes` on Linux, and the console
 * script is itself named `hermes`; a sampled process reported `comm=hermes`
 * with args `<venv>/bin/python <venv>/bin/hermes ...`. `looksLikeAgent`
 * matches either, so a JS-style launcher reporting `comm=python3.14` still
 * reads as live through its args.
 */
export const HERMES_AGENT_COMM = "hermes";

/** The .env variable the optional model key is stored under, named by `model.key_env`. */
export const MODEL_KEY_ENV = "CUSTOM_MODEL_API_KEY";

/**
 * The Suite channel platform's toolset key. `startup_suite` is the platform
 * name hermes-suite-channel registers (`PLATFORM_NAME`, adapter.py:74 at
 * {@link HERMES_CHANNEL_REF}); the gateway reads `platform_toolsets.<name>`
 * per turn (`_get_platform_tools`, hermes_cli/tools_config.py at fdec926e).
 */
export const TOOLSET_KEY = "platform_toolsets.startup_suite";

/**
 * The managed headless default for that key. `suite hermes` is an unattended
 * coding harness, not a chat-only webhook: without terminal + file it resorts
 * to application-specific escape hatches (the originating incident used
 * Godot's OS.exec) and cannot maintain its own workspace. Keep the list
 * explicit so a small-context model does not receive every Hermes tool.
 * `--full-toolset` still opts out to Hermes's own platform default.
 */
export const HEADLESS_TOOLSET: readonly string[] = ["hermes-webhook", "terminal", "file", "todo", "skills", "web"];
export const LEGACY_LEAN_TOOLSET: readonly string[] = ["hermes-webhook"];

/** Persistent equivalents of `--yolo --accept-hooks` for gateway turns. */
export const HEADLESS_CONFIG_DEFAULTS: readonly (readonly [string, string])[] = [
  ["approvals.mode", "off"],
  ["hooks_auto_accept", "true"],
] as const;

/** Whether a config.yaml value is exactly the managed headless default. */
export function isHeadlessToolset(value: unknown): boolean {
  return Array.isArray(value) && value.length === HEADLESS_TOOLSET.length && value.every((v, i) => v === HEADLESS_TOOLSET[i]);
}

/** Includes the old chat-only list so a repeat stamp upgrades it once. */
export function isManagedToolset(value: unknown): boolean {
  const same = (wanted: readonly string[]) =>
    Array.isArray(value) && value.length === wanted.length && value.every((v, i) => v === wanted[i]);
  return same(HEADLESS_TOOLSET) || same(LEGACY_LEAN_TOOLSET);
}

/**
 * The toolset key's planned outcome. An operator's own value is never
 * rewritten. Default mode upgrades the old managed list; `--full-toolset`
 * removes either managed list and leaves Hermes to choose its platform default.
 */
export function toolsetOutcome(current: unknown, fullToolset: boolean, absent: "written" | "repaired"): "written" | "repaired" | "unchanged" {
  const unset = current === undefined || current === null;
  if (fullToolset) return isManagedToolset(current) ? "repaired" : "unchanged";
  if (unset) return absent;
  return isManagedToolset(current) && !isHeadlessToolset(current) ? "repaired" : "unchanged";
}

/** Whether `current` is an operator's own toolset value, preserved as-is. */
export function isOperatorToolset(current: unknown): boolean {
  return current !== undefined && current !== null && !isManagedToolset(current);
}

/** Where `--install-hermes` leaves the launcher, relative to HERMES_HOME. */
export const MANAGED_HERMES_BIN = join("hermes-agent", ".hermes", "bin", "hermes");

/** What the upstream installer writes outside HERMES_HOME (install.sh:628-649, _launchers.py:549). */
export const OUTSIDE_HOME_WRITES =
  "shell rc PATH lines (~/.bashrc and ~/.profile, ~/.zshrc and ~/.zprofile, or fish config.fish, per $SHELL; " +
  "upstream install.sh:628-649) and the ~/.local/bin/{hermes,hermes-agent,hermes-acp} launchers";

/* ------------------------------------------------------------------------- */
/* Options                                                                    */
/* ------------------------------------------------------------------------- */

export interface HermesOptions {
  root: string;
  suiteUrl?: string;
  runtimeId?: string;
  tokenRef?: string;
  keychainService?: string;
  modelBaseUrl?: string;
  /** Hermes inference provider. Defaults from the base URL when omitted. */
  modelProvider?: string;
  model?: string;
  contextLength?: number;
  modelApiKeyRef?: string;
  allowedUsers?: string;
  hermes?: string;
  installHermes: boolean;
  /** Leave `platform_toolsets.startup_suite` to Hermes's own default (see {@link HEADLESS_TOOLSET}). */
  fullToolset: boolean;
  hermesHome: string;
  stampOnly: boolean;
  noSession: boolean;
  /** Internal to the session relaunch: run the stamped gateway, stamp nothing. */
  gatewayOnly: boolean;
  /** Everything after `--`, handed to `hermes gateway run`. */
  rest: string[];
  /** Our own arguments as given, minus `--stamp-only`: the session command. */
  sessionArgs: string[];
}

const VALUE_FLAGS: Record<string, keyof HermesOptions> = {
  "--root": "root",
  "--suite-url": "suiteUrl",
  "--runtime-id": "runtimeId",
  "--model-base-url": "modelBaseUrl",
  "--model-provider": "modelProvider",
  "--model": "model",
  "--context-length": "contextLength",
  "--model-api-key-ref": "modelApiKeyRef",
  "--allowed-users": "allowedUsers",
  "--hermes": "hermes",
  "--hermes-home": "hermesHome",
};

const BOOL_FLAGS: Record<string, "installHermes" | "fullToolset" | "stampOnly" | "noSession" | "gatewayOnly"> = {
  "--install-hermes": "installHermes",
  "--full-toolset": "fullToolset",
  "--stamp-only": "stampOnly",
  "--no-session": "noSession",
  "--gateway-only": "gatewayOnly",
};

/** True when `--stamp-only` appears before any `--`. Decided before parsing, so a refusal still emits JSON. */
export function wantsStampOnly(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "--stamp-only") return true;
  }
  return false;
}

/**
 * Parse `suite hermes` options. Throws a {@link StampFailure} (exit 2) for a
 * literal token, an unknown flag or a bad value. Scanning stops at `--`.
 * An unknown argument is never repeated in the message: it may be a value.
 */
export function parseHermesOptions(args: string[], cwd: string = process.cwd()): HermesOptions {
  const { tokenRef, keychainService, rest } = takeTokenRefFlags(args);
  const raw: Record<string, string> = {};
  const bools = { installHermes: false, fullToolset: false, stampOnly: false, noSession: false, gatewayOnly: false };
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
        ? `suite hermes: unknown option ${flag}`
        : "suite hermes: unexpected positional argument (not repeated here, in case it is a value); gateway arguments go after --",
    );
  }
  const rootArg = raw["--root"];
  if (rootArg === undefined) throw refused("root_required", "--root DIR is required");
  const root = resolve(cwd, rootArg);
  let contextLength: number | undefined;
  if (raw["--context-length"] !== undefined) {
    const s = raw["--context-length"];
    if (!/^[1-9][0-9]*$/.test(s)) throw refused("context_length_invalid", "--context-length must be a positive integer");
    contextLength = Number.parseInt(s, 10);
  }
  const hermesHome = resolve(cwd, raw["--hermes-home"] ?? join(root, ".hermes"));

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
    modelProvider: raw["--model-provider"],
    model: raw["--model"],
    contextLength,
    modelApiKeyRef: raw["--model-api-key-ref"],
    allowedUsers: raw["--allowed-users"],
    hermes: raw["--hermes"],
    hermesHome,
    ...bools,
    rest: gatewayArgs,
    sessionArgs,
  };
}

/** The agent's name: the root's directory name. */
export function agentNameForRoot(root: string): string {
  return basename(resolve(root));
}

/** Where the channel plugin checkout lives. Shared across agents: it is a program. */
export function channelCheckoutDir(env: Env): string {
  return join(dataDir(env), "hermes-suite-channel");
}

export function tokenFilePath(hermesHome: string): string {
  return join(hermesHome, TOKEN_RELPATH);
}

/* ------------------------------------------------------------------------- */
/* Pure parsers of measured Hermes output                                     */
/* ------------------------------------------------------------------------- */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

/**
 * The version token from `hermes --version`: the LOCAL commit.
 *
 * MEASURED at fdec926e, two shapes of the first line:
 *   Hermes Agent v0.21.5+2164.gfdec926 (2026.9.24) · upstream 346c14a9
 *   Hermes Agent vgit.fdec926 (2026.9.24) · upstream fdec926e
 * `upstream <sha>` is the REMOTE tip Hermes last fetched, not what is
 * installed: on the first shape it named a commit 49 ahead of the pinned one,
 * so every run warned "config shape unverified" on the exact pinned install.
 * It is never used. The local commit is the `g<sha>` of the git-describe
 * version, or the `git.<sha>` of an untagged one; a prefix of the pinned
 * commit is reported as the pinned commit's 8-character form. Otherwise the
 * `vX` token, then the whole line.
 */
export function parseHermesVersion(stdout: string): string {
  const first = stripAnsi(stdout).split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const local = /Hermes Agent v(?:git\.|\S*?\.g)([0-9a-f]{7,40})\b/.exec(first)?.[1];
  if (local !== undefined) return HERMES_AGENT_REF.startsWith(local) ? HERMES_AGENT_REF.slice(0, 8) : local.slice(0, 8);
  const v = /Hermes Agent v(\S+)/.exec(first);
  if (v?.[1] !== undefined) return v[1];
  return first === "" ? "unknown" : first;
}

/** The `Install directory: <path>` line of `hermes --version`, when it prints one. */
export function parseHermesInstallDir(stdout: string): string | null {
  const m = /^Install directory:\s*(\S.*?)\s*$/m.exec(stripAnsi(stdout));
  return m?.[1] ?? null;
}

/**
 * The interpreter of the dependency environment Hermes selects, from what
 * `hermes --run-module pm.environments` prints: Hermes's own activation
 * environment as JSON (pm/environments.py `__main__` at fdec926e), whose
 * PYTHONPATH is `<repo>:<venv>/lib/pythonX.Y/site-packages`. Null when the
 * output does not have that shape.
 */
export function pythonFromActivation(stdout: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const pp = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>).PYTHONPATH : undefined;
  if (typeof pp !== "string") return null;
  for (const entry of pp.split(":")) {
    const m = /^(.*)\/lib\/python[0-9.]+\/site-packages\/?$/.exec(entry);
    if (m?.[1] !== undefined) return join(m[1], "bin", "python");
  }
  return null;
}

/**
 * `hermes config check`. MEASURED at fdec926e: it always exits 0 unless
 * config.yaml fails to parse (exit 1, "Your settings file ... has a formatting
 * error"). Its body is a banner, `Config version: N ✓` (or `N → M (update
 * available)`), then `Required:` / `Optional:` groups where a missing required
 * variable prints `✗ NAME (missing)`.
 *
 *   pass         exit 0, a `Config version:` line, no `✗ ... (missing)` line
 *   fail         nonzero exit, or a missing required variable
 *   unparseable  exit 0 with no `Config version:` line
 */
export function parseConfigCheck(exitCode: number, stdout: string, stderr: string): ValidationCheck {
  const command = "hermes config check";
  const lines = stripAnsi(`${stdout}\n${stderr}`).split("\n").map((l) => l.trim());
  const firstLine = lines.find((l) => l !== "") ?? "";
  if (exitCode !== 0) return { command, exit_code: exitCode, verdict: "fail", raw: firstLine };
  const missing = lines.find((l) => /^✗\s+\S+\s+\(missing\)/.test(l));
  if (missing !== undefined) return { command, exit_code: exitCode, verdict: "fail", raw: missing };
  if (!lines.some((l) => /^Config version:\s*\d+/.test(l))) {
    return { command, exit_code: exitCode, verdict: "unparseable", raw: firstLine };
  }
  return { command, exit_code: exitCode, verdict: "pass" };
}

/**
 * `hermes mcp test startup-suite`. MEASURED at fdec926e against a stdio
 * server (hermes_cli/mcp_config.py:783): exit 0 connected, 1 connection
 * failed, 3 no such server. Connected output carries `✓ Connected (Nms)` and
 * `✓ Tools discovered: N`.
 *
 *   pass         exit 0, Connected, N > 0
 *   fail         exit 1 or 3, or Connected with 0 tools
 *   unparseable  anything else, including exit 0 without both lines
 */
export function parseMcpTest(exitCode: number, stdout: string, stderr: string): ValidationCheck {
  const command = `hermes mcp test ${MCP_SERVER_NAME}`;
  const lines = stripAnsi(`${stdout}\n${stderr}`).split("\n").map((l) => l.trim());
  const pick = (re: RegExp): string | undefined => lines.find((l) => re.test(l));
  const firstLine = lines.find((l) => l !== "") ?? "";
  if (exitCode === 1 || exitCode === 3) {
    return { command, exit_code: exitCode, verdict: "fail", raw: pick(/^✗/) ?? firstLine };
  }
  if (exitCode !== 0) return { command, exit_code: exitCode, verdict: "unparseable", raw: firstLine };
  const connected = pick(/^✓?\s*Connected\s*\(/);
  const toolsLine = pick(/Tools discovered:\s*\d+/);
  const n = toolsLine === undefined ? Number.NaN : Number.parseInt(/Tools discovered:\s*(\d+)/.exec(toolsLine)?.[1] ?? "", 10);
  if (connected === undefined || !Number.isInteger(n)) {
    return { command, exit_code: exitCode, verdict: "unparseable", raw: toolsLine ?? connected ?? firstLine };
  }
  if (n === 0) return { command, exit_code: exitCode, verdict: "fail", raw: toolsLine };
  return { command, exit_code: exitCode, verdict: "pass" };
}

/* ------------------------------------------------------------------------- */
/* config.yaml, read by parsing                                               */
/* ------------------------------------------------------------------------- */

export function readHermesConfig(hermesHome: string): Record<string, unknown> | null {
  const path = join(hermesHome, "config.yaml");
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = parseYaml(readFileSync(path, "utf8"));
  } catch {
    throw new StampFailure(
      EXIT_FAILED,
      "hermes_config_unparseable",
      `${path} is not valid YAML; \`hermes config check\` names the line to fix`,
    );
  }
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export function lookupKey(data: Record<string, unknown> | null, key: string): unknown {
  let node: unknown = data;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || !(part in (node as Record<string, unknown>))) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * The official Codex OAuth endpoint is not an OpenAI-compatible chat-completions
 * endpoint. Hermes openai-codex provider owns its Responses transport and
 * OAuth token handling; stamping it as custom makes Hermes append
 * /chat/completions and every turn fails with HTTP 404.
 *
 * Keep custom as the general endpoint default, but recognize the one canonical
 * provider-specific URL. An explicit flag wins for operators with a proxy or a
 * future provider implementation.
 */
export function modelProviderFor(opts: HermesOptions): string {
  if (opts.modelProvider !== undefined) return opts.modelProvider;
  const baseUrl = (opts.modelBaseUrl ?? "").replace(/\/+$/, "");
  return baseUrl === CODEX_BACKEND_BASE_URL ? "openai-codex" : "custom";
}

/** The model keys this verb manages, in write order. Values are never secret. */
export function desiredModelKeys(opts: HermesOptions): [string, string][] {
  const out: [string, string][] = [
    ["model.provider", modelProviderFor(opts)],
    ["model.base_url", opts.modelBaseUrl ?? ""],
    ["model.default", opts.model ?? ""],
  ];
  if (opts.contextLength !== undefined) out.push(["model.context_length", String(opts.contextLength)]);
  if (opts.modelApiKeyRef !== undefined) out.push(["model.key_env", MODEL_KEY_ENV]);
  return out;
}

/** Hermes coerces a digits-only value to an integer; compare the way it stores. */
export function sameConfigValue(current: unknown, desired: string): boolean {
  if (current === undefined || current === null) return false;
  if (typeof current === "number") return String(current) === desired;
  if (typeof current === "boolean") return String(current) === desired;
  return typeof current === "string" && current === desired;
}

/* ------------------------------------------------------------------------- */
/* Fingerprints of what the channel installer owns                            */
/* ------------------------------------------------------------------------- */

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export type ChannelPart = "channel_env" | "sanctioned_token_file" | "channel_plugin" | "mcp_server";

export const CHANNEL_PARTS: readonly ChannelPart[] = ["channel_env", "sanctioned_token_file", "channel_plugin", "mcp_server"];

export function channelPartTarget(part: ChannelPart, home: string): string {
  switch (part) {
    case "channel_env":
      return join(home, ".env");
    case "sanctioned_token_file":
      return tokenFilePath(home);
    case "channel_plugin":
      return join(home, "plugins", PLUGIN_NAME);
    case "mcp_server":
      return `${join(home, "config.yaml")}:mcp_servers.${MCP_SERVER_NAME}`;
  }
}

/**
 * A fingerprint per installer-owned part, or null when the part is absent.
 * The token file is fingerprinted by STAT (inode, size, mtime, mode), never by
 * content: its value must not enter this process for a `file:` ref. The
 * installer replaces it by rename only when its content changed, so a new
 * inode is a real change.
 */
export function channelFingerprints(home: string): Record<ChannelPart, string | null> {
  const envPath = join(home, ".env");
  const env = existsSync(envPath)
    ? sha(
        readFileSync(envPath, "utf8")
          .split("\n")
          .filter((l) => !new RegExp(`^\\s*(export\\s+)?${MODEL_KEY_ENV}\\s*=`).test(l))
          .join("\n"),
      )
    : null;
  let token: string | null = null;
  try {
    const st = lstatSync(tokenFilePath(home));
    token = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
  } catch {
    token = null;
  }
  let config: Record<string, unknown> | null = null;
  try {
    config = readHermesConfig(home);
  } catch {
    config = null;
  }
  const pluginDir = join(home, "plugins", PLUGIN_NAME);
  let plugin: string | null = null;
  if (existsSync(pluginDir)) {
    const build = join(pluginDir, "hermes_suite_channel", "_build.py");
    const enabled = lookupKey(config, "plugins.enabled");
    plugin = sha(
      `${existsSync(build) ? readFileSync(build, "utf8") : ""}\0${Array.isArray(enabled) && enabled.includes(PLUGIN_NAME)}`,
    );
  }
  const mcp = lookupKey(config, `mcp_servers.${MCP_SERVER_NAME}`);
  return {
    channel_env: env,
    sanctioned_token_file: token,
    channel_plugin: plugin,
    mcp_server: mcp === undefined ? null : sha(canonicalJson(mcp)),
  };
}

/* ------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* ------------------------------------------------------------------------- */

export interface HermesDeps {
  /** The environment children are built from (through harnessChildEnv). */
  env: Env;
  which(bin: string): string | null;
  stderr(text: string): void;
  /** Channel plugin source. Tests point these at a local fixture repo. */
  channelRepo?: string;
  channelRef?: string;
  /** Upstream hermes-agent installer: an https URL or an absolute file path. */
  hermesInstaller?: string;
  resolve?: ResolveDeps;
  stdin?: () => Promise<StdinState>;
  /** How the session is entered. */
  session: Pick<DeepseekDeps, "isTTY" | "exec" | "stderr">;
  tmux?: TmuxDeps;
  /** Records launches for restore-on-boot. Absent in tests: nothing recorded. */
  restore?: RestoreDeps;
  /** How to invoke this CLI again. */
  self?: string[];
}

/* ------------------------------------------------------------------------- */
/* The writer                                                                 */
/* ------------------------------------------------------------------------- */

interface WriterState {
  opts: HermesOptions | null;
  bin: string | null;
  installedNow: boolean;
  python: string | null;
  modelKey?: string;
  before: Record<ChannelPart, string | null> | null;
  /** Whether this root carried a stamp record before this run: an absent part is then a repair. */
  stampedBefore: boolean;
  channelActions: Map<ChannelPart, StampAction>;
  warnings: string[];
  secrets: string[];
}

function childEnvFor(deps: HermesDeps, home: string): Record<string, string> {
  return harnessChildEnv(deps.env, { HERMES_HOME: home });
}

function gitEnv(deps: HermesDeps): Record<string, string> {
  // SSH_AUTH_SOCK is not on the allowlist, and a private repo over ssh needs it.
  const env = harnessChildEnv(deps.env, {
    SSH_AUTH_SOCK: deps.env.SSH_AUTH_SOCK,
    GIT_SSH_COMMAND: deps.env.GIT_SSH_COMMAND,
  });
  return noGitPrompt(env) as Record<string, string>;
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
}

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveHermesBin(opts: HermesOptions, deps: Pick<HermesDeps, "which">): string | null {
  if (opts.hermes !== undefined) {
    if (isAbsolute(opts.hermes) || opts.hermes.includes("/")) {
      const p = resolve(opts.hermes);
      if (!isExecutable(p)) throw refused("hermes_not_found", `--hermes ${p} is not an executable file`);
      return p;
    }
    const found = deps.which(opts.hermes);
    if (found === null) throw refused("hermes_not_found", `--hermes ${opts.hermes} is not on PATH`);
    return found;
  }
  const managed = join(opts.hermesHome, MANAGED_HERMES_BIN);
  if (isExecutable(managed)) return managed;
  return deps.which("hermes");
}

/**
 * The interpreter Hermes's MCP client runs in, when Hermes itself cannot be
 * asked (see `pythonFromActivation`, which is tried first): the per-home
 * managed env (`installs/<id>/environments/<id>/venv`, newest first), else a
 * PYTHON launcher's shebang (through `env` when it uses one), else python3 on
 * PATH. A launcher whose shebang is a shell is a wrapper, not an interpreter:
 * at fdec926e every Hermes launcher is `#!/bin/sh`, and running
 * `/bin/sh -c 'import sys'` is how the channel installer failed.
 */
export function findHermesPython(home: string, bin: string, deps: Pick<HermesDeps, "which">): string {
  const installs = join(home, "installs");
  const managed: { path: string; mtime: number }[] = [];
  if (existsSync(installs)) {
    for (const a of readdirSync(installs)) {
      const envs = join(installs, a, "environments");
      if (!existsSync(envs)) continue;
      for (const b of readdirSync(envs)) {
        const py = join(envs, b, "venv", "bin", "python");
        if (existsSync(py)) managed.push({ path: py, mtime: statSync(join(envs, b)).mtimeMs });
      }
    }
  }
  managed.sort((x, y) => y.mtime - x.mtime || (x.path < y.path ? -1 : 1));
  if (managed[0] !== undefined) return managed[0].path;
  try {
    const first = readFileSync(bin, "utf8").split("\n")[0] ?? "";
    if (first.startsWith("#!")) {
      const words = first.slice(2).trim().split(/\s+/);
      let interp = words[0] ?? "";
      if (basename(interp) === "env" && words[1] !== undefined) interp = deps.which(words[1]) ?? "";
      if (interp !== "" && /^python/.test(basename(interp)) && isExecutable(interp)) return interp;
    }
  } catch {
    // unreadable launcher: fall through
  }
  return deps.which("python3") ?? "python3";
}

/** A value .env can hold unquoted, the way Hermes's own writer keeps it one line. */
function assertEnvValue(name: string, value: string): void {
  if (value === "" || /[\s#"'\\]/.test(value)) {
    throw refused(
      "env_value_unwritable",
      `${name} is empty or contains whitespace, '#', a quote or a backslash; refusing to write it to .env`,
    );
  }
}

function envFileWithKey(text: string | null, key: string, value: string): string {
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const lines = text === null || text === "" ? [] : text.replace(/\n$/, "").split("\n");
  let found = false;
  const out: string[] = [];
  for (const line of lines) {
    if (re.test(line)) {
      if (!found) out.push(`${key}=${value}`);
      found = true;
    } else out.push(line);
  }
  if (!found) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

function envKeyValue(text: string | null, key: string): string | undefined {
  if (text === null) return undefined;
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=(.*)$`);
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (m !== null) return (m[2] ?? "").trim();
  }
  return undefined;
}

/** A command line a human can paste. Quotes only what needs quoting. */
export function shellJoin(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

export function hermesWriter(ctx: { opts: HermesOptions | null }, deps: HermesDeps): HarnessWriter & { state: WriterState } {
  const state: WriterState = {
    opts: null,
    bin: null,
    installedNow: false,
    python: null,
    before: null,
    stampedBefore: false,
    channelActions: new Map(),
    warnings: [],
    secrets: [],
  };
  const opts = (): HermesOptions => {
    if (ctx.opts === null) throw new Error("hermes writer used before its options were parsed");
    return ctx.opts;
  };
  const channelRef = deps.channelRef ?? HERMES_CHANNEL_REF;
  const channelRepo = deps.channelRepo ?? HERMES_CHANNEL_REPO;
  const checkout = (): string => channelCheckoutDir(deps.env);
  const fail = (code: string, message: string): StampFailure =>
    new StampFailure(EXIT_FAILED, code, redact(message, state.secrets));

  const spawn = async (argv: string[], extra: { cwd?: string; stdinSecret?: string; env?: Record<string, string> } = {}) =>
    await spawnHarness(argv, {
      cwd: extra.cwd,
      env: extra.env ?? childEnvFor(deps, opts().hermesHome),
      stdinSecret: extra.stdinSecret,
      secrets: state.secrets,
    });

  async function installHermes(): Promise<void> {
    const home = opts().hermesHome;
    const source = deps.hermesInstaller ?? HERMES_INSTALLER_URL;
    const dir = join(dataDir(deps.env), "hermes-agent");
    const script = join(dir, `install-${HERMES_AGENT_REF.slice(0, 12)}.sh`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(script)) {
      if (/^https:\/\//.test(source)) {
        const res = await fetch(source);
        if (!res.ok) throw fail("hermes_installer_fetch_failed", `could not fetch ${source}: HTTP ${res.status}`);
        writeFileSync(`${script}.tmp`, await res.text(), { mode: 0o700 });
        renameSync(`${script}.tmp`, script);
      } else {
        copyFileSync(source, script);
        chmodSync(script, 0o700);
      }
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    deps.stderr(
      `suite: installing Hermes Agent ${HERMES_AGENT_REF.slice(0, 8)} into ${home} with its upstream installer (--non-interactive)\n` +
        `suite: note: that installer also writes OUTSIDE ${home}: ${OUTSIDE_HOME_WRITES}\n`,
    );
    const r = await spawn(["bash", script, "--non-interactive", "--commit", HERMES_AGENT_REF, "--hermes-home", home], {
      cwd: home,
    });
    if (r.stderr !== "") deps.stderr(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    if (r.stdout !== "") deps.stderr(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    if (r.exitCode !== 0) {
      throw fail("hermes_install_failed", `the upstream Hermes installer exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
    }
    state.installedNow = true;
    state.warnings.push(`the upstream Hermes installer wrote outside HERMES_HOME: ${OUTSIDE_HOME_WRITES}`);
  }

  async function gitHead(): Promise<string | null> {
    if (!existsSync(join(checkout(), ".git"))) return null;
    const r = await spawn(["git", "-C", checkout(), "rev-parse", "HEAD"], { env: gitEnv(deps) });
    return r.exitCode === 0 ? r.stdout.trim() : "";
  }

  async function ensureCheckout(): Promise<void> {
    const dir = checkout();
    const env = gitEnv(deps);
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dirname(dir), { recursive: true });
      const r = await spawn(["git", "clone", "--quiet", channelRepo, dir], { env });
      if (r.exitCode !== 0) throw fail("plugin_clone_failed", `git clone ${channelRepo} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const has = await spawn(["git", "-C", dir, "cat-file", "-e", `${channelRef}^{commit}`], { env });
    if (has.exitCode !== 0) {
      const f = await spawn(["git", "-C", dir, "fetch", "--quiet", "origin"], { env });
      if (f.exitCode !== 0) {
        const detail = f.stderr || f.stdout;
        throw fail(
          "plugin_fetch_failed",
          [`the plugin checkout at ${dir} could not fetch ${channelRef}:`, detail.trim(), ...pullRemedyLines(classifyPullFailure(detail), dir)].join("\n"),
        );
      }
    }
    const co = await spawn(["git", "-C", dir, "checkout", "--quiet", "--detach", channelRef], { env });
    if (co.exitCode !== 0) throw fail("plugin_checkout_failed", `git checkout ${channelRef} in ${dir} failed: ${co.stderr.trim()}`);
  }

  async function runInstaller(inputs: StampInputs): Promise<void> {
    const o = opts();
    const bin = state.bin as string;
    const argv = [
      "bash",
      join(checkout(), "install.sh"),
      "--url",
      runtimeWsUrl(inputs.suiteUrl),
      "--runtime-id",
      inputs.runtimeId,
      "--hermes-home",
      o.hermesHome,
      "--hermes",
      bin,
      // The interpreter this verb already resolved (and installs the mcp SDK
      // into). The launcher is a #!/bin/sh wrapper at fdec926e, so the
      // installer must not have to guess it from a shebang.
      "--python",
      state.python as string,
      ...(o.allowedUsers !== undefined ? ["--allowed-users", o.allowedUsers] : ["--allow-all-users"]),
      ...(inputs.tokenRef.kind === "file" ? ["--token-file", inputs.tokenRef.path] : []),
    ];
    const r = await spawn(argv, {
      cwd: checkout(),
      stdinSecret: inputs.tokenRef.kind === "keychain" ? inputs.tokenValue : undefined,
    });
    // The installer ends by suggesting `hermes gateway restart`. This verb
    // never runs that (it installs a systemd unit); say what happens instead.
    for (const line of redact(r.stderr, state.secrets).split("\n")) {
      if (line.trim() === "") continue;
      if (/gateway restart/.test(line)) {
        deps.stderr("suite: (the gateway is started by `suite hermes` with `hermes gateway run`; never `gateway restart`)\n");
        continue;
      }
      deps.stderr(`${line}\n`);
    }
    if (r.exitCode !== 0) {
      throw fail("channel_install_failed", `the hermes-suite-channel installer exited ${r.exitCode}: ${lastLine(r.stderr)}`);
    }
    if (lastLine(r.stdout) !== INSTALLER_RESULT_LINE) {
      throw fail("channel_install_unparseable", `the hermes-suite-channel installer did not end with "${INSTALLER_RESULT_LINE}": ${lastLine(r.stdout)}`);
    }
  }

  /**
   * Ask Hermes which interpreter its dependencies live in. The only answer
   * that is Hermes's own: the launcher is a shell wrapper, and the
   * environment it selects is a generation PM chooses (installs/<key>/facts.json),
   * which a directory scan can only approximate. Null when this Hermes does
   * not answer (an older or non-PM install): the caller falls back.
   * The output is Hermes's environment as JSON; only PYTHONPATH is read and
   * nothing of it is logged.
   */
  async function askHermesPython(bin: string): Promise<string | null> {
    const r = await spawn([bin, "--run-module", "pm.environments"]);
    if (r.exitCode !== 0) return null;
    const py = pythonFromActivation(r.stdout);
    return py !== null && isExecutable(py) ? py : null;
  }

  async function importsMcp(py: string): Promise<boolean> {
    const r = await spawn([py, "-c", "import mcp"]);
    return r.exitCode === 0;
  }

  async function installMcp(py: string): Promise<void> {
    let r = await spawn([py, "-m", "pip", "install", "--quiet", MCP_SDK_PIN]);
    let how = `${py} -m pip`;
    // A uv-made venv has no pip (measured: the fdec926e managed env says
    // "No module named pip"); uv installs into it by interpreter path.
    if (r.exitCode !== 0 && /No module named pip/.test(r.stderr)) {
      const uv = deps.which("uv");
      if (uv !== null) {
        r = await spawn([uv, "pip", "install", "--quiet", "--python", py, MCP_SDK_PIN]);
        how = `${uv} pip --python ${py}`;
      }
    }
    if (r.exitCode !== 0 || !(await importsMcp(py))) {
      throw fail(
        "mcp_sdk_install_failed",
        `could not install ${MCP_SDK_PIN} into ${py} (tried ${how}): ${lastLine(r.stderr || r.stdout)}. ` +
          `The venv may lack pip; install uv, or run: uv pip install --python ${py} ${MCP_SDK_PIN}`,
      );
    }
  }

  const writer: HarnessWriter & { state: WriterState } = {
    state,
    harness: "hermes",
    writerVersion: WRITER_VERSION,
    measuredHarnessVersions: MEASURED_HERMES_VERSIONS,
    pluginRef: channelRef,

    async detectVersion() {
      const o = opts();
      let bin = resolveHermesBin(o, deps);
      if (bin === null && o.installHermes) {
        await installHermes();
        bin = resolveHermesBin(o, deps);
        if (bin === null) {
          throw fail("hermes_install_failed", `the upstream installer finished but no hermes was found at ${join(o.hermesHome, MANAGED_HERMES_BIN)}`);
        }
      }
      if (bin === null) return null;
      state.bin = bin;
      const r = await spawn([bin, "--version"]);
      if (r.exitCode !== 0) throw fail("harness_broken", `${bin} --version exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
      // The install's own commit, from git, when it is a git checkout; the
      // --version line's local token otherwise (never its `upstream` token).
      const dir = parseHermesInstallDir(r.stdout);
      if (dir !== null && existsSync(join(dir, ".git"))) {
        const head = await spawn(["git", "-C", dir, "rev-parse", "HEAD"], { env: gitEnv(deps) });
        const sha = head.stdout.trim();
        if (head.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha.slice(0, 8);
      }
      return parseHermesVersion(r.stdout);
    },

    performed() {
      if (!state.installedNow) return [];
      const home = opts().hermesHome;
      return [
        { kind: "harness_install", target: `${join(home, "hermes-agent")}@${HERMES_AGENT_REF.slice(0, 8)}`, outcome: "written", applied: true },
        { kind: "upstream_outside_hermes_home", target: OUTSIDE_HOME_WRITES, outcome: "written", applied: true },
      ];
    },

    needsTokenValue(ref: TokenRef) {
      // A file ref goes to the installer as --token-file; only a keychain
      // item has to be read here, to be piped to the installer's stdin.
      return ref.kind === "keychain";
    },

    async plan(inputs) {
      const o = opts();
      if (inputs.tokenValue !== undefined) state.secrets.push(inputs.tokenValue);
      const actions: StampAction[] = [];
      const home = o.hermesHome;
      const bin = state.bin as string;
      // On a root that was stamped before, a part found absent was deleted:
      // restoring it is a repair, not a first write.
      state.stampedBefore = (await readStampRecord(o.root)) !== null;
      const absent = state.stampedBefore ? "repaired" : "written";

      const head = await gitHead();
      actions.push(planned("plugin_checkout", `${checkout()}@${channelRef}`, head === null ? "written" : head === channelRef ? "unchanged" : "repaired"));

      state.before = channelFingerprints(home);
      for (const part of CHANNEL_PARTS) {
        const a = planned(part, channelPartTarget(part, home), state.before[part] === null ? absent : "unchanged");
        state.channelActions.set(part, a);
        actions.push(a);
      }

      const py = (await askHermesPython(bin)) ?? findHermesPython(home, bin, deps);
      state.python = py;
      actions.push(planned("mcp_sdk", `${py} ${MCP_SDK_PIN}`, (await importsMcp(py)) ? "unchanged" : absent));

      const config = readHermesConfig(home);
      for (const [key, value] of desiredModelKeys(o)) {
        const current = lookupKey(config, key);
        actions.push(
          planned("config_set", key, current === undefined || current === null ? absent : sameConfigValue(current, value) ? "unchanged" : "repaired"),
        );
      }
      const toolsets = lookupKey(config, TOOLSET_KEY);
      actions.push(planned("config_set", TOOLSET_KEY, toolsetOutcome(toolsets, o.fullToolset, absent)));
      if (isOperatorToolset(toolsets)) {
        state.warnings.push(
          `${TOOLSET_KEY} holds an operator-set value; left unchanged (the stamp's own default is ${JSON.stringify(HEADLESS_TOOLSET)}, and it never overwrites another value)`,
        );
      }

      for (const [key, value] of HEADLESS_CONFIG_DEFAULTS) {
        const current = lookupKey(config, key);
        const unset = current === undefined || current === null;
        actions.push(planned("config_set", key, unset ? absent : "unchanged"));
        if (!unset && !sameConfigValue(current, value)) {
          state.warnings.push(key + " holds an operator-set value; left unchanged (the unattended default is " + value + ")");
        }
      }

      if (o.modelApiKeyRef !== undefined) {
        const ref = parseTokenRef(o.modelApiKeyRef, { keychainService: o.keychainService });
        const value = await resolveTokenRef(ref, deps.resolve);
        state.modelKey = value;
        state.secrets.push(value);
        assertEnvValue("the model API key", value);
        const envPath = join(home, ".env");
        const current = envKeyValue(existsSync(envPath) ? readFileSync(envPath, "utf8") : null, MODEL_KEY_ENV);
        actions.push(planned("env_key", `${envPath}:${MODEL_KEY_ENV}`, current === undefined ? absent : current === value ? "unchanged" : "repaired"));
      }
      return actions;
    },

    async apply(inputs, actions) {
      const o = opts();
      const home = o.hermesHome;
      const bin = state.bin as string;
      mkdirSync(home, { recursive: true, mode: 0o700 });

      const co = actions.find((a) => a.kind === "plugin_checkout");
      if (co !== undefined && co.outcome !== "unchanged") {
        await ensureCheckout();
        co.applied = true;
      }

      // Always run: the installer is idempotent, and it IS the repair path
      // for a deleted MCP entry or a changed runtime id. Its parts are
      // MEASURED afterwards, and also when it fails part-way: a part it did
      // change is reported as changed, and a part it never reached as not
      // applied.
      const measureParts = (): void => {
        const after = channelFingerprints(home);
        const before = state.before as Record<ChannelPart, string | null>;
        for (const part of CHANNEL_PARTS) {
          const a = state.channelActions.get(part) as StampAction;
          if (after[part] !== before[part]) {
            a.outcome = before[part] === null && !state.stampedBefore ? "written" : "repaired";
            a.applied = true;
          } else if (a.outcome === "unchanged" || after[part] !== null) {
            a.outcome = "unchanged";
            a.applied = true;
          }
        }
      };
      try {
        await runInstaller(inputs);
      } finally {
        measureParts();
      }
      // Installing a plugin with Python dependencies makes Hermes commit a NEW
      // dependency venv (MEASURED on a fresh fdec926e install: the generation
      // named in installs/<key>/facts.json changed during `hermes plugins
      // install`). The MCP command registered a moment ago then names the old
      // one, and the next run would "repair" it. Ask again, and register the
      // one Hermes now selects.
      const selected = await askHermesPython(bin);
      if (selected !== null && selected !== state.python) {
        deps.stderr(`suite: Hermes selected a new dependency environment while installing the plugin; registering the MCP bridge with ${selected}\n`);
        state.python = selected;
        // The SDK check moves to the new interpreter; the step below installs it if missing.
        const sdkAction = actions.find((a) => a.kind === "mcp_sdk");
        if (sdkAction !== undefined) {
          const has = await importsMcp(selected);
          sdkAction.target = `${selected} ${MCP_SDK_PIN}`;
          if (has) sdkAction.outcome = "unchanged";
          else if (sdkAction.outcome === "unchanged") sdkAction.outcome = state.stampedBefore ? "repaired" : "written";
          sdkAction.applied = has;
        }
        try {
          await runInstaller(inputs);
        } finally {
          measureParts();
        }
      }
      const tokenPath = tokenFilePath(home);
      let mode = -1;
      try {
        mode = lstatSync(tokenPath).mode & 0o777;
      } catch {
        mode = -1;
      }
      if (mode !== 0o600) {
        throw fail("token_file_mode", `the channel installer left ${tokenPath} ${mode < 0 ? "absent" : `mode 0${mode.toString(8)}`}; it must be 0600`);
      }
      deps.stderr(
        `suite: the runtime token is held in ${tokenPath} (mode 0600), the one sanctioned copy; ` +
          `the Hermes channel plugin reads it from that file and has no keychain resolver yet\n`,
      );
      if (inputs.tokenRef.kind === "keychain") {
        state.warnings.push(
          `keychain ref ${inputs.tokenRef.raw} was materialised into ${tokenPath} (0600): hermes-suite-channel has no keychain resolver (follow-up)`,
        );
      }

      const sdk = actions.find((a) => a.kind === "mcp_sdk");
      if (sdk !== undefined && sdk.outcome !== "unchanged") {
        await installMcp(state.python as string);
        sdk.applied = true;
      }

      const wanted = new Map(desiredModelKeys(o));
      for (const a of actions) {
        if (a.kind !== "config_set" || a.outcome === "unchanged" || a.target === TOOLSET_KEY || !wanted.has(a.target)) continue;
        const value = wanted.get(a.target) as string;
        const r = await spawn([bin, "config", "set", a.target, value]);
        if (r.exitCode !== 0) throw fail("config_set_failed", `hermes config set ${a.target} exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
      }
      const config = readHermesConfig(home);
      for (const [key, value] of wanted) {
        if (!sameConfigValue(lookupKey(config, key), value)) {
          throw fail("config_set_ineffective", `hermes config set ${key} exited 0 but config.yaml does not hold the value`);
        }
        const a = actions.find((x) => x.kind === "config_set" && x.target === key);
        if (a !== undefined) a.applied = true;
      }

      const headlessDefaults = new Map(HEADLESS_CONFIG_DEFAULTS);
      for (const a of actions) {
        const value = headlessDefaults.get(a.target);
        if (a.kind !== "config_set" || value === undefined || a.outcome === "unchanged") continue;
        const r = await spawn([bin, "config", "set", a.target, value]);
        if (r.exitCode !== 0) throw fail("config_set_failed", `hermes config set ${a.target} exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
        const now = lookupKey(readHermesConfig(home), a.target);
        if (!sameConfigValue(now, value)) throw fail("config_set_ineffective", `hermes config set ${a.target} exited 0 but config.yaml does not hold the value`);
        a.applied = true;
      }

      // The toolset key: set the managed headless list, or (--full-toolset)
      // remove a managed list a previous stamp wrote. `unset` is Hermes's own remover.
      const ts = actions.find((a) => a.kind === "config_set" && a.target === TOOLSET_KEY);
      if (ts !== undefined && ts.outcome !== "unchanged") {
        const argv = o.fullToolset ? [bin, "config", "unset", TOOLSET_KEY] : [bin, "config", "set", TOOLSET_KEY, JSON.stringify(HEADLESS_TOOLSET)];
        const r = await spawn(argv);
        if (r.exitCode !== 0) throw fail("config_set_failed", `hermes config ${argv[2]} ${TOOLSET_KEY} exited ${r.exitCode}: ${lastLine(r.stderr || r.stdout)}`);
        const now = lookupKey(readHermesConfig(home), TOOLSET_KEY);
        const held = o.fullToolset ? now === undefined || now === null : isHeadlessToolset(now);
        if (!held) throw fail("config_set_ineffective", `hermes config ${argv[2]} ${TOOLSET_KEY} exited 0 but config.yaml does not reflect it`);
        ts.applied = true;
      }

      const envKey = actions.find((a) => a.kind === "env_key");
      if (envKey !== undefined && state.modelKey !== undefined) {
        if (envKey.outcome !== "unchanged") {
          const envPath = join(home, ".env");
          const next = envFileWithKey(existsSync(envPath) ? readFileSync(envPath, "utf8") : null, MODEL_KEY_ENV, state.modelKey);
          const tmp = `${envPath}.suite-${process.pid}`;
          writeFileSync(tmp, next, { mode: 0o600 });
          chmodSync(tmp, 0o600);
          renameSync(tmp, envPath);
          envKey.applied = true;
        }
        state.warnings.push(
          `the model API key is stored in ${join(home, ".env")} as ${MODEL_KEY_ENV}; Hermes copies .env into os.environ ` +
            `every turn and children it spawns without a scrub inherit it (upstream defect)`,
        );
      }
    },

    async validate() {
      const bin = state.bin as string;
      const cc = await spawn([bin, "config", "check"]);
      const mt = await spawn([bin, "mcp", "test", MCP_SERVER_NAME]);
      const checks = [parseConfigCheck(cc.exitCode, cc.stdout, cc.stderr), parseMcpTest(mt.exitCode, mt.stdout, mt.stderr)];
      for (const c of checks) if (c.raw !== undefined) c.raw = redact(c.raw, state.secrets);
      const verdict: ValidationVerdict = { verdict: "pass", checks };
      return verdict;
    },

    humanSteps(): HumanStep[] {
      return [{ kind: "start_agent_session", text: shellJoin(["suite", "hermes", ...opts().sessionArgs]) }];
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

function stampRequest(opts: HermesOptions): StampRequest {
  if (opts.modelBaseUrl === undefined) throw refused("model_base_url_required", "--model-base-url URL is required");
  if (opts.model === undefined) throw refused("model_required", "--model ID is required");
  return {
    root: opts.root,
    name: agentNameForRoot(opts.root),
    suiteUrl: opts.suiteUrl,
    runtimeId: opts.runtimeId,
    tokenRef: opts.tokenRef,
    keychainService: opts.keychainService,
    nonSecret: {
      hermesHome: opts.hermesHome,
      modelBaseUrl: opts.modelBaseUrl,
      model: opts.model,
      contextLength: opts.contextLength,
      modelApiKeyRef: opts.modelApiKeyRef,
      allowedUsers: opts.allowedUsers,
      hermes: opts.hermes,
      fullToolset: opts.fullToolset,
    },
  };
}

/** `hermes gateway run` plus the operator's arguments. Never start/restart/install. */
export function gatewayArgv(bin: string, rest: string[]): string[] {
  return [bin, "gateway", "run", ...rest];
}

/** The tmux relaunch: this CLI again, gateway only, no session. Carries no secret. */
export function relaunchArgv(self: string[], opts: HermesOptions, bin: string): string[] {
  return [
    ...self,
    "hermes",
    "--root",
    opts.root,
    "--gateway-only",
    "--no-session",
    "--hermes",
    bin,
    "--hermes-home",
    opts.hermesHome,
    "--",
    ...opts.rest,
  ];
}

/** The gateway's environment: the allowlist plus HERMES_HOME. No Suite credential, by construction. */
export function gatewayEnv(deps: Pick<HermesDeps, "env">, opts: HermesOptions): Record<string, string> {
  return harnessChildEnv(deps.env, { HERMES_HOME: opts.hermesHome });
}

async function runGateway(opts: HermesOptions, deps: HermesDeps): Promise<number> {
  const record = await readStampRecord(opts.root);
  if (record === null || record.harness !== "hermes" || record.verdict !== "pass") {
    deps.stderr(`suite: ${join(opts.root, STAMP_FILE)} records no passing hermes stamp; run suite hermes without --gateway-only first\n`);
    return EXIT_REFUSED;
  }
  const bin = resolveHermesBin(opts, deps);
  if (bin === null) {
    deps.stderr("suite: hermes is not installed; pass --hermes BIN\n");
    return EXIT_REFUSED;
  }
  const argv = gatewayArgv(bin, opts.rest);
  assertNoSecretsInArgv(argv, createStore());
  return await deps.session.exec(argv, { cwd: opts.root, env: gatewayEnv(deps, opts) });
}

/**
 * Run the verb. Returns the process exit code.
 *
 * `--stamp-only`: the machine contract, nothing else.
 * `--gateway-only` (the relaunch inside tmux): exec `hermes gateway run`.
 * Otherwise: stamp (human lines on stderr), then start or attach to the
 * `suite-<name>` session — or, with `--no-session`, run the gateway in the
 * foreground.
 */
function stampParts(args: string[], deps: HermesDeps) {
  const ctx: { opts: HermesOptions | null } = { opts: null };
  const writer = hermesWriter(ctx, deps);
  const build = (): StampRequest => {
    ctx.opts = parseHermesOptions(args);
    return stampRequest(ctx.opts);
  };
  const stampDeps: StampDeps = { resolve: deps.resolve, stdin: deps.stdin };
  return { writer, build, stampDeps };
}

/** One stamp, in process, with the human lines going to `io.stderr`. Writes nothing to stdout. */
export async function stampHermes(args: string[], deps: HermesDeps, io: StampIO) {
  const { writer, build, stampDeps } = stampParts(args, deps);
  const out = await runStamp(writer, build, io, stampDeps);
  return { ...out, writer };
}

export async function runHermes(args: string[], deps: HermesDeps): Promise<number> {
  if (wantsStampOnly(args)) {
    const { writer, build, stampDeps } = stampParts(args, deps);
    return await stampCommand(writer, build, stampDeps);
  }

  let opts: HermesOptions;
  try {
    opts = parseHermesOptions(args);
  } catch (e) {
    if (e instanceof StampFailure) {
      deps.stderr(`suite: ${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
  if (opts.gatewayOnly) return await runGateway(opts, deps);

  const { exitCode, writer } = await stampHermes(args, deps, { stdout: () => {}, stderr: deps.stderr });
  if (exitCode !== 0) return exitCode;
  const bin = writer.state.bin as string;

  if (opts.noSession) {
    const argv = gatewayArgv(bin, opts.rest);
    assertNoSecretsInArgv(argv, createStore());
    return await deps.session.exec(argv, { cwd: opts.root, env: gatewayEnv(deps, opts) });
  }

  const session = sessionNameForAgent(agentNameForRoot(opts.root));
  const relaunch = relaunchArgv(deps.self ?? selfArgv(deps.env as NodeJS.ProcessEnv), opts, bin);
  const home = deps.env.HOME ?? "";
  // TMUX is not on the child allowlist, but the nesting decision reads it:
  // without it a run from inside tmux would nest an attach instead of switching.
  const sessionEnv = harnessChildEnv(deps.env, { HERMES_HOME: opts.hermesHome, TMUX: deps.env.TMUX });
  return await runInSession(session, relaunch, opts.root, sessionEnv, createStore(), deps.session, {
    agentName: HERMES_AGENT_COMM,
    tmux: deps.tmux,
    onCreated: (createArgv) => {
      if (deps.restore) recordLaunch(deps.restore, home, { session, command: createArgv, cwd: opts.root, kind: "hermes" });
    },
    wasRecorded: () => deps.restore !== undefined && loadRoster(deps.restore, home).some((e) => e.session === session),
  });
}

export function liveHermesDeps(): HermesDeps {
  return {
    env: process.env,
    which: (bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }),
    stderr: (t) => void process.stderr.write(t),
    session: liveDeepseekDeps(),
    restore: liveRestoreDeps(),
  };
}
