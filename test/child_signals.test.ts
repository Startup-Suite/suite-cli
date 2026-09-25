import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { exitStatus, shouldForward } from "../src/child_signals.ts";

/**
 * A signalled `--gateway-only` wrapper must not leave its gateway behind.
 * Real processes, real signals: a wrapper runs `sleep 300`, the test signals
 * the WRAPPER only, then checks whether the child still exists.
 */
const WRAPPER = resolve(import.meta.dir, "fixtures", "signal-wrapper.ts");
const leftovers: number[] = [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function start(mode: "forward" | "plain") {
  const wrapper = Bun.spawn([process.execPath, WRAPPER, mode], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = wrapper.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const child = Number.parseInt(text.trim(), 10);
  leftovers.push(child);
  expect(alive(child)).toBe(true);
  return { wrapper, child };
}

async function gone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

afterEach(() => {
  for (const pid of leftovers.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

describe("a signalled wrapper takes its child down", () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    test(`${signal} to the wrapper: the child is gone and the wrapper exits after it`, async () => {
      const { wrapper, child } = await start("forward");
      wrapper.kill(signal);
      const code = await wrapper.exited;
      expect(await gone(child)).toBe(true);
      // sleep was ended by the forwarded signal: 128 + its number.
      expect(code).toBe(exitStatus(null, signal));
    });
  }

  test("positive control: the bare spawn this replaced leaves the child orphaned on SIGTERM", async () => {
    const { wrapper, child } = await start("plain");
    wrapper.kill("SIGTERM");
    await wrapper.exited;
    await Bun.sleep(200);
    expect(alive(child)).toBe(true);
  });
});

describe("the forwarding rule", () => {
  test("SIGINT is not re-sent when a terminal already delivered it to the whole group", () => {
    expect(shouldForward("SIGINT", true)).toBe(false);
    expect(shouldForward("SIGINT", false)).toBe(true);
    expect(shouldForward("SIGTERM", true)).toBe(true);
    expect(shouldForward("SIGHUP", true)).toBe(true);
  });

  test("exit status: the code, else 128 + the signal", () => {
    expect(exitStatus(3, null)).toBe(3);
    expect(exitStatus(null, "SIGTERM")).toBe(143);
    expect(exitStatus(null, "SIGINT")).toBe(130);
  });
});
