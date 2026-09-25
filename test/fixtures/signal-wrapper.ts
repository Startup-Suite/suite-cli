/**
 * A `--gateway-only` wrapper in miniature, for test/child_signals.test.ts:
 * spawns `sleep 300` the way the session exec does and prints the child's pid
 * on stdout. argv[2] picks the exec: `forward` (src/child_signals.ts) or
 * `plain` (a bare Bun.spawn + await, the exec this replaced).
 */
import { runForwardingSignals } from "../../src/child_signals.ts";

const mode = process.argv[2];
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
if (mode === "forward") {
  const code = await runForwardingSignals(["sleep", "300"], {
    cwd: "/",
    env,
    stdinIsTTY: false,
    onSpawn: (pid) => void process.stdout.write(`${pid}\n`),
  });
  process.exit(code);
} else {
  const child = Bun.spawn(["sleep", "300"], { cwd: "/", env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.stdout.write(`${child.pid}\n`);
  process.exit(await child.exited);
}
