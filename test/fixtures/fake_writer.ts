/**
 * A HarnessWriter with no harness behind it, for exercising the stamp runner.
 *
 * Its "config" is one JSON file in the root, so idempotence and repair are
 * observable as file bytes. Nothing here is a real host, id or token.
 */
import { join } from "node:path";
import type { HarnessWriter, StampInputs } from "../../src/stamp.ts";
import { StampFailure, planned, refused, type StampAction, type Verdict } from "../../src/stamp_result.ts";

export interface FakeWriterOptions {
  version?: string | null;
  measured?: string[];
  verdict?: Verdict;
  needsValue?: boolean;
  /** Emit stray lines on process stdout, which the runner must divert. */
  noise?: boolean;
  /** Throw from apply AFTER the config write (`after`) or before it (`before`). */
  failApply?: "before" | "after";
  /** Report a harness install performed by detectVersion, then refuse from plan. */
  installThenRefuse?: boolean;
}

export const FAKE_CONFIG = "fake-harness.json";

export function fakeWriter(options: FakeWriterOptions = {}): HarnessWriter & { seen: { tokenValue?: string } } {
  const seen: { tokenValue?: string } = {};
  const desired = (i: StampInputs): string =>
    `${JSON.stringify({ url: i.suiteUrl, runtimeId: i.runtimeId, token: i.tokenRef.raw }, null, 2)}\n`;
  return {
    seen,
    harness: "fake",
    writerVersion: 1,
    measuredHarnessVersions: options.measured ?? ["1.0.0"],
    pluginRef: "fake-plugin@0000000",
    async detectVersion() {
      return options.version === undefined ? "1.0.0" : options.version;
    },
    needsTokenValue: () => options.needsValue === true,
    performed: () =>
      options.installThenRefuse === true ? [{ kind: "harness_install", target: "fake-harness@1.0.0", outcome: "written", applied: true }] : [],
    async plan(i): Promise<StampAction[]> {
      if (options.installThenRefuse === true) throw refused("port_in_use", "fake: the port is in use");
      const f = Bun.file(join(i.root, FAKE_CONFIG));
      const current = (await f.exists()) ? await f.text() : null;
      const next = desired(i);
      const outcome = current === null ? "written" : current === next ? "unchanged" : "repaired";
      const actions = [planned("config_set", `${FAKE_CONFIG}:account`, outcome)];
      // A second write that apply never reaches when it fails after the first.
      if (options.failApply === "after") actions.push(planned("config_set", `${FAKE_CONFIG}:second`, "written"));
      return actions;
    },
    async apply(i, actions) {
      if (options.noise === true) {
        console.log("a human line from console.log");
        process.stdout.write("a human line from process.stdout.write\n");
      }
      seen.tokenValue = i.tokenValue;
      if (options.failApply === "before") throw new StampFailure(1, "fake_failed", "fake: failed before writing");
      if (actions.every((a) => a.outcome === "unchanged")) return;
      await Bun.write(join(i.root, FAKE_CONFIG), desired(i));
      const first = actions[0];
      if (first !== undefined) first.applied = true;
      if (options.failApply === "after") throw new StampFailure(1, "fake_failed", "fake: failed after the first write");
      for (const a of actions) a.applied = true;
    },
    async validate() {
      const verdict = options.verdict ?? "pass";
      return {
        verdict,
        checks: [
          {
            command: "fake check",
            exit_code: verdict === "pass" ? 0 : 1,
            verdict,
            ...(verdict === "unparseable" ? { raw: "??? garbled status line" } : {}),
          },
        ],
      };
    },
    humanSteps: (i) => [{ kind: "start_agent_session", text: `suite fake --root ${i.root}` }],
  };
}
