/**
 * A HarnessWriter with no harness behind it, for exercising the stamp runner.
 *
 * Its "config" is one JSON file in the root, so idempotence and repair are
 * observable as file bytes. Nothing here is a real host, id or token.
 */
import { join } from "node:path";
import type { HarnessWriter, StampInputs } from "../../src/stamp.ts";
import type { StampAction, Verdict } from "../../src/stamp_result.ts";

export interface FakeWriterOptions {
  version?: string | null;
  measured?: string[];
  verdict?: Verdict;
  needsValue?: boolean;
  /** Emit stray lines on process stdout, which the runner must divert. */
  noise?: boolean;
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
    async plan(i): Promise<StampAction[]> {
      const f = Bun.file(join(i.root, FAKE_CONFIG));
      const current = (await f.exists()) ? await f.text() : null;
      const next = desired(i);
      const outcome = current === null ? "written" : current === next ? "unchanged" : "repaired";
      return [{ kind: "config_set", target: `${FAKE_CONFIG}:account`, outcome }];
    },
    async apply(i, actions) {
      if (options.noise === true) {
        console.log("a human line from console.log");
        process.stdout.write("a human line from process.stdout.write\n");
      }
      seen.tokenValue = i.tokenValue;
      if (actions.every((a) => a.outcome === "unchanged")) return;
      await Bun.write(join(i.root, FAKE_CONFIG), desired(i));
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
