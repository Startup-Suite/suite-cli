import { describe, expect, test } from "bun:test";
import {
  LAUNCHD_LABEL,
  RSS_CEILING_BYTES,
  SERVICE_NAME,
  type SupervisorIo,
  installSupervisor,
  SUPERVISED_ENV,
  launchdBootstrappable,
  launchdPlist,
  tmuxSupervisorArgv,
  parseEnvFile,
  readTelemetryAuth,
  servicePath,
  supervisorPlan,
  systemdUnit,
} from "../src/supervisor.ts";

const base = { home: "/home/q", binary: "/home/q/.local/bin/suite", intervalSeconds: 60 };

describe("the PATH clause", () => {
  /**
   * The whole reason the supervisor sets PATH explicitly. A service started by
   * systemd or launchd inherits a minimal PATH; on macOS that excludes
   * Homebrew, where tmux lives. A watcher that cannot find tmux resolves every
   * session as absent, and "no sessions" is reported as a healthy sweep — a
   * silent, total failure that looks exactly like success.
   */
  test("includes both Homebrew prefixes and the suite install dir", () => {
    const p = servicePath("/home/q");
    expect(p).toContain("/opt/homebrew/bin");
    expect(p).toContain("/home/linuxbrew/.linuxbrew/bin");
    expect(p).toContain("/usr/local/bin");
    expect(p).toContain("/home/q/.local/bin");
  });

  test("both unit kinds carry it", () => {
    expect(systemdUnit({ ...base, platform: "linux" })).toContain("/opt/homebrew/bin");
    expect(launchdPlist({ ...base, platform: "darwin" })).toContain("/opt/homebrew/bin");
  });
});

describe("units never carry credentials", () => {
  /**
   * A systemd unit is world-readable and a LaunchAgent plist is readable by
   * anything running as the user. The telemetry credential is referenced by
   * file, not embedded, and the reference is optional so an absent file cannot
   * stop the service starting.
   */
  test("systemd sources an optional env file rather than inlining a token", () => {
    const unit = systemdUnit({ ...base, platform: "linux" });
    expect(unit).toContain("EnvironmentFile=-/home/q/.config/suite/watch.env");
    expect(unit).not.toContain("SUITE_TELEMETRY_AUTH=");
  });

  test("launchd plist embeds no credential either", () => {
    expect(launchdPlist({ ...base, platform: "darwin" })).not.toContain("SUITE_TELEMETRY_AUTH");
  });
});

describe("plan per platform", () => {
  test("linux gets a user service, never a system one", () => {
    const plan = supervisorPlan({ ...base, platform: "linux" });
    expect(plan.kind).toBe("systemd");
    expect(plan.path).toBe(`/home/q/.config/systemd/user/${SERVICE_NAME}.service`);
    for (const argv of plan.activate) expect(argv).toContain("--user");
  });

  test("darwin gets a LaunchAgent under the user's home", () => {
    const plan = supervisorPlan({ ...base, platform: "darwin" });
    expect(plan.kind).toBe("launchd");
    expect(plan.path).toBe(`/home/q/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  });

  /**
   * A container with neither init system is a legitimate host for the CLI.
   * `init` must not fail there — it must say plainly that nothing is watching.
   */
  test("an unsupported platform is an outcome, not an error", () => {
    const plan = supervisorPlan({ ...base, platform: "win32" });
    expect(plan.kind).toBe("unsupported");
    expect(plan.activate).toEqual([]);
    expect(plan.summary).toContain("suite watch");
  });

  test("the unit invokes an absolute binary, never a bare name", () => {
    expect(systemdUnit({ ...base, platform: "linux" })).toContain(
      "ExecStart=/home/q/.local/bin/suite watch",
    );
  });
});

function recordingIo(codes: number[] = []): { io: SupervisorIo; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    io: {
      mkdirp: (d) => calls.push(`mkdirp ${d}`),
      writeFile: (p) => calls.push(`write ${p}`),
      run: async (argv) => {
        calls.push(argv.join(" "));
        return { exitCode: codes[i++] ?? 0 };
      },
    },
  };
}

describe("installing", () => {
  test("creates the unit directory before writing into it", async () => {
    const { io, calls } = recordingIo();
    await installSupervisor(io, supervisorPlan({ ...base, platform: "linux" }));
    expect(calls[0]).toBe("mkdirp /home/q/.config/systemd/user");
    expect(calls[1]).toBe("write /home/q/.config/systemd/user/suite-watch.service");
  });

  /**
   * `init` is re-runnable, so launchd's first step tears down a label that may
   * not exist yet. That failure is expected and must not be reported as a
   * broken install.
   */
  test("launchd's teardown step is allowed to fail on a first install", async () => {
    const { io } = recordingIo([1, 0]);
    const res = await installSupervisor(io, supervisorPlan({ ...base, platform: "darwin" }));
    expect(res.installed).toBe(true);
  });

  /**
   * Updated when the tmux fallback was extended to Linux: a failed systemctl
   * alone no longer means unsupervised, because the fallback takes over. Only
   * BOTH paths failing is a real failure, and that is what must be reported
   * rather than thrown.
   */
  test("a failure is reported rather than thrown when the fallback also fails", async () => {
    const io: SupervisorIo = {
      mkdirp: () => {},
      writeFile: () => {},
      run: async () => ({ exitCode: 1 }),
    };
    const res = await installSupervisor(io, supervisorPlan({ ...base, platform: "linux" }));
    expect(res.installed).toBe(false);
    expect(res.summary).toContain("not started");
  });

  test("unsupported platforms write nothing at all", async () => {
    const { io, calls } = recordingIo();
    const res = await installSupervisor(io, supervisorPlan({ ...base, platform: "win32" }));
    expect(res.installed).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("inheriting the installer's PATH", () => {
  /**
   * The hardcoded list is a guess; the installing process's PATH is evidence.
   * A real Linux host kept tmux under Linuxbrew, in a directory no plausible
   * default contained, and the service died on every sweep until its PATH was
   * taken from the shell that demonstrably could find it.
   */
  test("the inherited PATH is carried into the unit, ahead of the defaults", () => {
    const unit = systemdUnit({
      ...base,
      platform: "linux",
      inheritedPath: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
    });
    expect(unit).toContain("Environment=PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:");
  });

  test("directories are not duplicated when they appear in both", () => {
    const p = servicePath("/home/q", "/usr/bin:/home/q/.local/bin");
    expect(p.split(":").filter((d) => d === "/usr/bin")).toHaveLength(1);
    expect(p.split(":").filter((d) => d === "/home/q/.local/bin")).toHaveLength(1);
  });

  test("works with no inherited PATH at all", () => {
    expect(servicePath("/home/q")).toContain("/usr/bin");
  });
});

describe("the watchdog cannot harm its host", () => {
  /**
   * The reason this exists: an earlier version shipped with no resource limit
   * at all, and the operator discovered that by power-cycling the machine.
   * Whatever the eventual cause, a watchdog with no ceiling is a design fault
   * on its own.
   */
  test("systemd caps memory, forbids swap, and limits CPU", () => {
    const unit = systemdUnit({ ...base, platform: "linux" });
    expect(unit).toContain("MemoryMax=512M");
    expect(unit).toContain("MemorySwapMax=0");
    expect(unit).toContain("CPUQuota=");
  });

  /**
   * launchd has NO hard memory cap, so the plist cannot carry an equivalent.
   * That asymmetry is real and is covered in-process by RSS_CEILING_BYTES
   * instead — recorded here so nobody reads the missing key as an oversight.
   */
  test("launchd deprioritises, since macOS offers no memory ceiling", () => {
    const plist = launchdPlist({ ...base, platform: "darwin" });
    expect(plist).toContain("<key>ProcessType</key><string>Background</string>");
    expect(plist).not.toContain("MemoryMax");
  });

  test("the in-process ceiling is what makes macOS bounded", () => {
    expect(RSS_CEILING_BYTES).toBeGreaterThan(0);
  });
});

describe("telemetry credential", () => {
  /**
   * systemd sources the env file itself; launchd cannot, and its only native
   * alternative is embedding the secret in a plist readable by anything running
   * as that user. Reading the file in-process keeps one 0600 file as the single
   * home for the credential and behaves the same on both platforms.
   */
  test("prefers the environment when it is set", () => {
    expect(readTelemetryAuth({ SUITE_TELEMETRY_AUTH: "Basic abc", HOME: "/h" }, () => null)).toBe(
      "Basic abc",
    );
  });

  test("falls back to the env file, which is how macOS gets it at all", () => {
    const auth = readTelemetryAuth({ HOME: "/h" }, (p) => {
      expect(p).toBe("/h/.config/suite/watch.env");
      return "# comment\nSUITE_TELEMETRY_AUTH=Basic zzz\n";
    });
    expect(auth).toBe("Basic zzz");
  });

  test("absent everywhere is null, not a throw — telemetry is optional", () => {
    expect(readTelemetryAuth({ HOME: "/h" }, () => null)).toBeNull();
  });

  test("a value containing '=' survives parsing (base64 padding)", () => {
    expect(parseEnvFile("SUITE_TELEMETRY_AUTH=Basic YWJjOmRlZg==").SUITE_TELEMETRY_AUTH).toBe(
      "Basic YWJjOmRlZg==",
    );
  });

  test("blank lines and comments are ignored", () => {
    expect(Object.keys(parseEnvFile("\n# x\n\nA=1\n"))).toEqual(["A"]);
  });
});

describe("macOS without a GUI session", () => {
  /**
   * A LaunchAgent lives in the Aqua domain. Over SSH with nobody at the
   * console there is no such domain, and every bootstrap form fails —
   * gui/<uid> 125, user/<uid> 5, legacy load 134. Observed on a real host.
   */
  test("Aqua is required; Background is not enough", () => {
    expect(launchdBootstrappable("Aqua")).toBe(true);
    expect(launchdBootstrappable("Background")).toBe(false);
  });

  test("the darwin plan carries a headless fallback", () => {
    const plan = supervisorPlan({ ...base, platform: "darwin" });
    expect(plan.fallback).toBeDefined();
    expect(plan.fallback?.argv.some((a) => a.includes("new-session"))).toBe(true);
  });

  test("the fallback marks its child supervised, or it would reinstall forever", () => {
    const argv = tmuxSupervisorArgv("/bin/suite", 60);
    expect(argv.some((a) => a.includes(`${SUPERVISED_ENV}=1`))).toBe(true);
  });

  /**
   * The whole point: never report a machine as supervised when nothing is
   * running. Failure must either fall back to something real, or say so.
   */
  test("a failed bootstrap falls back to tmux and reports tmux, not launchd", async () => {
    const calls: string[] = [];
    let n = 0;
    const io: SupervisorIo = {
      mkdirp: () => {},
      writeFile: () => {},
      run: async (argv) => {
        calls.push(argv[0] ?? "");
        // teardown, bootstrap(fail), tmux kill(fail, absent), tmux new(ok)
        n++;
        return { exitCode: n === 2 ? 125 : n === 3 ? 1 : 0 };
      },
    };
    const res = await installSupervisor(io, supervisorPlan({ ...base, platform: "darwin" }));
    expect(res.kind).toBe("tmux");
    expect(res.installed).toBe(true);
    expect(calls).toContain("tmux");
  });

  test("if the fallback also fails, it reports not-started rather than success", async () => {
    const io: SupervisorIo = {
      mkdirp: () => {},
      writeFile: () => {},
      run: async () => ({ exitCode: 9 }),
    };
    const res = await installSupervisor(io, supervisorPlan({ ...base, platform: "darwin" }));
    expect(res.installed).toBe(false);
    expect(res.summary).toContain("not started");
  });
});

describe("Linux without user systemd", () => {
  /**
   * Not every Linux has a user systemd instance — containers, Alpine, WSL, a
   * box with no session bus. Before this, those hosts wrote a unit that never
   * started and ran nothing, while macOS fell back correctly. A supervisor
   * that silently supervises nothing is the failure this whole thing exists
   * to prevent.
   */
  test("the linux plan carries the same tmux fallback macOS has", () => {
    const plan = supervisorPlan({ ...base, platform: "linux" });
    expect(plan.fallback).toBeDefined();
    expect(plan.fallback?.argv.some((a) => a.includes("new-session"))).toBe(true);
  });

  test("a failed systemctl falls back and reports tmux, not systemd", async () => {
    let n = 0;
    const io: SupervisorIo = {
      mkdirp: () => {},
      writeFile: () => {},
      run: async () => {
        n++;
        // daemon-reload ok, enable fails, tmux kill fails (absent), new ok
        return { exitCode: n === 2 ? 1 : n === 3 ? 1 : 0 };
      },
    };
    const res = await installSupervisor(io, supervisorPlan({ ...base, platform: "linux" }));
    expect(res.kind).toBe("tmux");
    expect(res.installed).toBe(true);
  });
});
