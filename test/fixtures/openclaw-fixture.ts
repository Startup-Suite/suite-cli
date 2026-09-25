/**
 * `suite openclaw` as a real subprocess, with the channel plugin source pointed
 * at a local fixture repo, so tests can assert on the actual stdout / stderr /
 * exit code split of `--stamp-only`.
 *
 *   OPENCLAW_FIXTURE_REPO  the fixture channel repo (a local git path)
 *   OPENCLAW_FIXTURE_REF   the commit to pin
 *
 * Both are OPENCLAW_* names on purpose: harnessChildEnv strips them, so they
 * cannot leak into any child this run spawns.
 */
import { liveOpenclawDeps, runOpenclaw } from "../../src/commands/openclaw.ts";

const deps = { ...liveOpenclawDeps(), restore: undefined };
deps.channelRepo = process.env.OPENCLAW_FIXTURE_REPO;
deps.channelRef = process.env.OPENCLAW_FIXTURE_REF;
process.exit(await runOpenclaw(process.argv.slice(2), deps));
