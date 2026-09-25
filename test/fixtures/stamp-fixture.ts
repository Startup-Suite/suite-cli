/**
 * A tiny stamp verb over the fake writer, run as a real subprocess so tests
 * can assert on the actual stdout / stderr / exit code split.
 *
 *   bun test/fixtures/stamp-fixture.ts --root DIR [--suite-url U] [--runtime-id R]
 *       [--token-ref REF] [--keychain-service S] [--token ...]
 *
 * Behaviour knobs come from STAMP_FIXTURE_* env vars (see below).
 */
import { stampCommand } from "../../src/stamp.ts";
import { takeTokenRefFlags } from "../../src/token_ref.ts";
import { fakeWriter } from "./fake_writer.ts";

const env = process.env;
const writer = fakeWriter({
  version: env.STAMP_FIXTURE_ABSENT === "1" ? null : (env.STAMP_FIXTURE_VERSION ?? "1.0.0"),
  verdict: (env.STAMP_FIXTURE_VERDICT as "pass" | "fail" | "unparseable" | undefined) ?? "pass",
  needsValue: env.STAMP_FIXTURE_NEEDS_VALUE === "1",
  noise: env.STAMP_FIXTURE_NOISE === "1",
});

const code = await stampCommand(
  writer,
  () => {
    const { tokenRef, keychainService, rest } = takeTokenRefFlags(process.argv.slice(2));
    const take = (flag: string): string | undefined => {
      const i = rest.indexOf(flag);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const root = take("--root");
    if (root === undefined) throw new Error("--root is required");
    return {
      root,
      name: "fake-agent",
      suiteUrl: take("--suite-url"),
      runtimeId: take("--runtime-id"),
      tokenRef,
      keychainService,
    };
  },
  {
    resolve: {
      platform: (env.STAMP_FIXTURE_PLATFORM as NodeJS.Platform | undefined) ?? process.platform,
      securityBin: env.STAMP_FIXTURE_SECURITY,
    },
  },
);
process.exit(code);
