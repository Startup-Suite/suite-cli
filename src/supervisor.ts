import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Keeping `suite watch` running without anyone remembering to start it.
 *
 * A supervisor you have to discover is a supervisor that is not running on the
 * morning it was needed. So `suite init` installs one: a user-level service on
 * Linux, a LaunchAgent on macOS. Both are unprivileged — nothing here needs
 * root, and nothing here touches a system-wide unit directory.
 *
 * THE PATH CLAUSE IS THE POINT, not boilerplate. A service started by systemd
 * or launchd inherits a minimal PATH — on macOS that excludes Homebrew, which
 * is where tmux lives. A watcher that cannot find tmux resolves every session
 * as absent, and a sweep that finds no sessions reports success. The failure is
 * silent, total, and indistinguishable from a healthy box. This was observed
 * for real over a non-interactive ssh, which has the same minimal PATH: it
 * reported a host as having no agent sessions while that host was running two.
 */

export type SupervisorKind = "systemd" | "launchd" | "tmux" | "unsupported";

/**
 * Whether a LaunchAgent can actually be started right now.
 *
 * A LaunchAgent lives in the per-user GUI (Aqua) domain. Over SSH with nobody
 * logged in at the console there IS no such domain — `launchctl managername`
 * answers "Background", and every bootstrap fails: gui/<uid> with 125 "Domain
 * does not support specified action", user/<uid> with 5, legacy load with 134.
 * The plist is still worth writing (it loads at the next GUI login), but the
 * machine is not supervised until then, and saying otherwise would be a lie
 * told to an operator who then stops watching.
 */
export function launchdBootstrappable(managerName: string): boolean {
  return managerName.trim() === "Aqua";
}

export interface SupervisorInput {
  platform: NodeJS.Platform;
  home: string;
  /** PATH of the process installing the unit. See servicePath. */
  inheritedPath?: string;
  /** Locale of the installing process. See serviceLocale — this is load-bearing. */
  inheritedLocale?: string;
  /** Absolute path to the suite executable. Never a bare name — see above. */
  binary: string;
  /** Seconds between sweeps. */
  intervalSeconds: number;
}

export interface SupervisorPlan {
  kind: SupervisorKind;
  /** Where the unit is written. Empty when unsupported. */
  path: string;
  /** Unit file contents. Empty when unsupported. */
  contents: string;
  /** Commands that make it live, in order. */
  activate: string[][];
  /** Shown to the operator; the reason when unsupported. */
  summary: string;
  /**
   * Headless fallback, used when `activate` cannot work in this context.
   * On macOS with no GUI session this is the only thing that actually runs —
   * and it is the same mechanism already keeping the agents on that box alive.
   */
  fallback?: { argv: string[][]; summary: string };
}

/** Detached tmux session running the watcher; survives logout, needs no GUI. */
export function tmuxSupervisorArgv(binary: string, intervalSeconds: number): string[][] {
  return [
    ["tmux", "kill-session", "-t", SERVICE_NAME],
    [
      "tmux",
      "new-session",
      "-d",
      "-s",
      SERVICE_NAME,
      "-e",
      `${SUPERVISED_ENV}=1`,
      "-e",
      `LANG=${serviceLocale(process.env.LANG)}`,
      binary,
      "watch",
      "--interval",
      String(intervalSeconds),
    ],
  ];
}

export const SERVICE_NAME = "suite-watch";

/**
 * Set in the unit, read by the command.
 *
 * `suite watch` installs its own service so no separate setup step exists to
 * forget. The service then runs `suite watch` — which would install it again,
 * every restart, forever. This variable is how the process knows it IS the
 * daemon and should get on with sweeping rather than re-installing itself.
 */
export const SUPERVISED_ENV = "SUITE_WATCH_SUPERVISED";

/**
 * Self-imposed ceiling, in bytes.
 *
 * systemd enforces MemoryMax for us; launchd offers no hard memory cap at all,
 * so on macOS this in-process check IS the limit rather than a backstop. Either
 * way the process exits and is restarted clean, which turns an unbounded leak
 * into a bounded restart. Stated rather than assumed: the two platforms are NOT
 * equally protected by the unit files alone.
 */
export const RSS_CEILING_BYTES = 512 * 1024 * 1024;
export const LAUNCHD_LABEL = "technology.milvenan.suite-watch";

/**
 * PATH given to the service.
 *
 * Homebrew's two prefixes are listed explicitly (Apple silicon and Intel)
 * because the whole failure mode this guards against is a PATH that lacks
 * them. `~/.local/bin` carries the suite install itself.
 */
export function servicePath(home: string, inherited?: string): string {
  // The INHERITED PATH goes first and is the important half. The operator's own
  // shell is live proof of where their tools actually are; a hardcoded list is
  // a guess. Guessing failed for real here — a Linux box had tmux under
  // Linuxbrew at /home/linuxbrew/.linuxbrew/bin, which no plausible default
  // list contained, and the service died on every sweep.
  const dirs = [
    ...(inherited ? inherited.split(":") : []),
    `${home}/.local/bin`,
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs.filter((d) => d !== ""))].join(":");
}

/**
 * Optional environment file, sourced only if the operator created it.
 *
 * Credentials never go in the unit: a systemd unit is world-readable and a
 * LaunchAgent plist is readable by anything running as the user. The env file
 * is the operator's to create and chmod; its absence must not stop the service
 * from starting, which is why systemd gets the `-` prefix and launchd is given
 * no reference to it at all.
 */
/**
 * Locale for the service, and it is NOT cosmetic.
 *
 * With no locale set, tmux substitutes the TAB in `-F` format output with an
 * underscore. Every parser in this CLI splits those rows on tab, so they all
 * yield nothing — `list-panes` appears to return no sessions, the sweep finds
 * nothing to do, and the watchdog reports a clean box forever. Measured on a
 * real host: byte 23 of the same command is 9 under a normal shell and 95 under
 * `env -i`, and setting either LANG or LC_ALL restores it.
 *
 * launchd and systemd both hand a service a minimal environment with no locale,
 * so a supervisor installed without this is silently blind from the moment it
 * starts — which is the exact failure it exists to catch.
 */
export function serviceLocale(inherited?: string): string {
  return inherited && inherited !== "" && inherited !== "C" && inherited !== "POSIX"
    ? inherited
    : "en_US.UTF-8";
}

export function envFilePath(home: string): string {
  return `${home}/.config/suite/watch.env`;
}

export function systemdUnit(input: SupervisorInput): string {
  return `[Unit]
Description=Suite agent session watchdog
Documentation=https://github.com/Startup-Suite/suite-cli
After=default.target

[Service]
Type=simple
Environment=PATH=${servicePath(input.home, input.inheritedPath)}
Environment=HOME=${input.home}
Environment=LANG=${serviceLocale(input.inheritedLocale)}
Environment=${SUPERVISED_ENV}=1
EnvironmentFile=-${envFilePath(input.home)}
ExecStart=${input.binary} watch --interval ${input.intervalSeconds}
Restart=always
RestartSec=30

# A watchdog must be incapable of harming the host it watches. Without these a
# leak in the sweep is indistinguishable from a leak anywhere else on the box,
# and the operator finds out by power-cycling. The cap is generous next to a
# healthy sweep (~110MB) and far below anything that could hurt a host.
MemoryMax=512M
MemorySwapMax=0
CPUQuota=25%

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(input: SupervisorInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${input.binary}</string>
    <string>watch</string>
    <string>--interval</string>
    <string>${input.intervalSeconds}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${servicePath(input.home, input.inheritedPath)}</string>
    <key>HOME</key><string>${input.home}</string>
    <key>LANG</key><string>${serviceLocale(input.inheritedLocale)}</string>
    <key>${SUPERVISED_ENV}</key><string>1</string>
  </dict>
  <key>Nice</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${input.home}/.local/state/suite-watch.log</string>
  <key>StandardErrorPath</key><string>${input.home}/.local/state/suite-watch.log</string>
</dict>
</plist>
`;
}

/**
 * What installing the supervisor on this machine involves.
 *
 * Unsupported is a first-class outcome, not a failure: a container with neither
 * init system is a legitimate place to run the CLI, and `init` must not fail
 * there. The operator is told plainly that nothing is watching.
 */
export function supervisorPlan(input: SupervisorInput): SupervisorPlan {
  if (input.platform === "darwin") {
    const path = `${input.home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
    return {
      kind: "launchd",
      path,
      contents: launchdPlist(input),
      // `bootout` first so a re-run replaces cleanly rather than erroring on an
      // already-loaded label; it is allowed to fail on the first install.
      activate: [
        ["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`],
        ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 501}`, path],
      ],
      summary: `LaunchAgent ${LAUNCHD_LABEL}`,
      fallback: {
        argv: tmuxSupervisorArgv(input.binary, input.intervalSeconds),
        summary: `tmux session ${SERVICE_NAME} (no GUI session; LaunchAgent will also load at next login)`,
      },
    };
  }
  if (input.platform === "linux") {
    const path = `${input.home}/.config/systemd/user/${SERVICE_NAME}.service`;
    return {
      kind: "systemd",
      path,
      contents: systemdUnit(input),
      activate: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", `${SERVICE_NAME}.service`],
      ],
      summary: `systemd user service ${SERVICE_NAME}.service`,
      // Not every Linux has a user systemd instance — containers, Alpine, WSL
      // without systemd, a box with no user session bus. Without this, those
      // hosts write a unit that never starts and get NO supervision at all,
      // while macOS (which has the same problem for a different reason) falls
      // back fine. Same escape hatch for both.
      fallback: {
        argv: tmuxSupervisorArgv(input.binary, input.intervalSeconds),
        summary: `tmux session ${SERVICE_NAME} (no user systemd; unit written for when there is one)`,
      },
    };
  }
  return {
    kind: "unsupported",
    path: "",
    contents: "",
    activate: [],
    summary: `no supported service manager on ${input.platform}; run "suite watch" yourself`,
  };
}

export interface SupervisorIo {
  mkdirp(dir: string): void;
  writeFile(path: string, contents: string): void;
  run(argv: string[]): Promise<{ exitCode: number }>;
}

export interface SupervisorResult {
  kind: SupervisorKind;
  installed: boolean;
  summary: string;
}

/**
 * Write the unit and make it live. Idempotent: `init` is re-runnable, so this
 * overwrites its own unit and re-activates rather than detecting and skipping.
 *
 * Activation failure is reported, never thrown. A box where the service manager
 * refuses (no user session bus, an unusual container) still gets a working CLI
 * and an operator who has been told the watchdog is not running — which is the
 * honest outcome, and better than an init that aborts halfway.
 */
export async function installSupervisor(
  io: SupervisorIo,
  plan: SupervisorPlan,
): Promise<SupervisorResult> {
  if (plan.kind === "unsupported") {
    return { kind: plan.kind, installed: false, summary: plan.summary };
  }
  const dir = plan.path.slice(0, plan.path.lastIndexOf("/"));
  io.mkdirp(dir);
  io.writeFile(plan.path, plan.contents);

  let ok = true;
  for (const [index, argv] of plan.activate.entries()) {
    const { exitCode } = await io.run(argv);
    // The first launchd step is a teardown of a possibly-absent label; only a
    // later step failing means the service did not come up.
    const teardown = plan.kind === "launchd" && index === 0;
    if (exitCode !== 0 && !teardown) ok = false;
  }
  if (ok) return { kind: plan.kind, installed: ok, summary: plan.summary };

  // Activation failed. Rather than report a machine as supervised when nothing
  // is running, try the headless fallback and say which one actually took.
  if (plan.fallback) {
    let fb = true;
    for (const [index, argv] of plan.fallback.argv.entries()) {
      const { exitCode } = await io.run(argv);
      if (exitCode !== 0 && index !== 0) fb = false; // first is a teardown
    }
    if (fb) return { kind: "tmux", installed: true, summary: plan.fallback.summary };
  }
  return { kind: plan.kind, installed: false, summary: `${plan.summary} — written but not started` };
}

/**
 * Absolute path of the running suite executable, for baking into the unit.
 *
 * A service gets a minimal PATH, so a bare `suite` in ExecStart fails to start
 * with nothing useful in the log. `argv[1]` is preferred when it is already
 * absolute (a source checkout run under bun); otherwise the installed location.
 */
export function resolveSelfBinary(
  env: Record<string, string | undefined>,
  argv: string[],
): string {
  const home = env.HOME ?? "";
  const installed = `${home}/.local/bin/suite`;
  const self = argv[1];
  if (self && self.startsWith("/") && self.endsWith("/suite")) return self;
  return installed;
}

/**
 * Read `KEY=value` pairs from the optional watch env file.
 *
 * systemd can source this itself via EnvironmentFile; launchd has NO such
 * mechanism, and the only launchd-native alternative is embedding the value in
 * the plist — a file readable by anything running as that user. Reading it in
 * the process keeps the credential in one 0600 file and behaves identically on
 * both platforms, which is the whole point of the CLI being portable.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Telemetry credential, from the environment if present, else the env file.
 * Absent is fine — telemetry is optional and detection still works without it.
 */
export function readTelemetryAuth(
  env: Record<string, string | undefined>,
  readFile: (p: string) => string | null,
): string | null {
  const direct = env.SUITE_TELEMETRY_AUTH;
  if (direct) return direct;
  const contents = readFile(envFilePath(env.HOME ?? ""));
  if (contents === null) return null;
  return parseEnvFile(contents).SUITE_TELEMETRY_AUTH ?? null;
}

/** The real filesystem and service manager. */
export function liveSupervisorIo(): SupervisorIo {
  return {
    mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
    writeFile: (path, contents) => void writeFileSync(path, contents),
    async run(argv) {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      return { exitCode: await proc.exited };
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Agent restore on boot — written, never enabled                             */
/* ------------------------------------------------------------------------- */

export const RESTORE_SERVICE_NAME = "suite-agents";
export const RESTORE_LAUNCHD_LABEL = "technology.milvenan.suite-agents";

/**
 * Unit that brings recorded agents back after a reboot.
 *
 * WRITTEN BY `init`, NOT ENABLED BY IT. Starting agent processes unattended is
 * a per-machine decision an operator makes deliberately — a host came back from
 * a power cycle with an agent silently missing, which is the problem this
 * solves, but the fix must not itself be a surprise. `init` prints the one
 * command that turns it on.
 *
 * `oneshot`, not `simple`: restore runs, starts what is absent, and exits. It
 * is not a daemon, and marking it one would have systemd restart it forever.
 */
export function restoreUnit(input: SupervisorInput): string {
  return `[Unit]
Description=Restore Suite agent sessions after boot
Documentation=https://github.com/Startup-Suite/suite-cli
After=default.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PATH=${servicePath(input.home, input.inheritedPath)}
Environment=HOME=${input.home}
Environment=LANG=${serviceLocale(input.inheritedLocale)}
ExecStart=${input.binary} restore

[Install]
WantedBy=default.target
`;
}

export function restoreLaunchdPlist(input: SupervisorInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${RESTORE_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${input.binary}</string>
    <string>restore</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${servicePath(input.home, input.inheritedPath)}</string>
    <key>HOME</key><string>${input.home}</string>
    <key>LANG</key><string>${serviceLocale(input.inheritedLocale)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${input.home}/.local/state/suite-agents.log</string>
</dict>
</plist>
`;
}

export interface RestoreUnitPlan {
  kind: SupervisorKind;
  path: string;
  contents: string;
  /** The exact command the operator runs to turn it on. Never run for them. */
  enableHint: string;
}

export function restoreUnitPlan(input: SupervisorInput): RestoreUnitPlan | null {
  if (input.platform === "linux") {
    return {
      kind: "systemd",
      path: `${input.home}/.config/systemd/user/${RESTORE_SERVICE_NAME}.service`,
      contents: restoreUnit(input),
      enableHint: `systemctl --user enable --now ${RESTORE_SERVICE_NAME}.service`,
    };
  }
  if (input.platform === "darwin") {
    const path = `${input.home}/Library/LaunchAgents/${RESTORE_LAUNCHD_LABEL}.plist`;
    return {
      kind: "launchd",
      path,
      contents: restoreLaunchdPlist(input),
      enableHint: `launchctl bootstrap gui/$(id -u) ${path}`,
    };
  }
  return null;
}

/** Write the unit only. Enabling is the operator's, by construction. */
export function writeRestoreUnit(io: SupervisorIo, plan: RestoreUnitPlan): void {
  io.mkdirp(plan.path.slice(0, plan.path.lastIndexOf("/")));
  io.writeFile(plan.path, plan.contents);
}

/**
 * Make sure this machine is supervised, from any command that starts an agent.
 *
 * `suite init` wires a machine up, but a box is not necessarily initialised by
 * the person who later runs an agent on it, and a session started on an
 * unsupervised host is exactly the one that dies quietly overnight. So the
 * command that CREATES a session also guarantees the watchdog exists, rather
 * than relying on someone having run init first.
 *
 * Idempotent and non-fatal by construction: it re-writes its own unit and
 * re-activates, and a failure here must never stop an agent from starting —
 * the agent is the point, supervision is insurance.
 */
export async function ensureSupervision(
  io: SupervisorIo,
  input: SupervisorInput,
): Promise<{ watchdog: string; restore: string | null }> {
  let watchdog: string;
  try {
    const res = await installSupervisor(io, supervisorPlan(input));
    watchdog = res.installed ? res.summary : `NOT running: ${res.summary}`;
  } catch (err) {
    watchdog = `NOT running: ${(err as Error).message}`;
  }

  // Restore-on-boot is written, never enabled — the operator opts in per
  // machine. Writing it here means the option exists on a box that was never
  // explicitly initialised.
  let restore: string | null = null;
  try {
    const plan = restoreUnitPlan(input);
    if (plan) {
      writeRestoreUnit(io, plan);
      restore = plan.enableHint;
    }
  } catch {
    restore = null;
  }
  return { watchdog, restore };
}
