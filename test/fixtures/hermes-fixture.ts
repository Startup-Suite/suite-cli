/**
 * `suite hermes` as a real subprocess, with the channel plugin source pointed
 * at a local fixture repo, so tests can assert on the actual stdout / stderr /
 * exit code split of `--stamp-only`.
 *
 *   HERMES_FIXTURE_REPO  the fixture channel repo (a local git path)
 *   HERMES_FIXTURE_REF   the commit to pin
 *
 * Both are HERMES_* names on purpose: harnessChildEnv strips them, so they
 * cannot leak into any child this run spawns.
 */
import { liveHermesDeps, runHermes } from "../../src/commands/hermes.ts";

const deps = { ...liveHermesDeps(), restore: undefined };
deps.channelRepo = process.env.HERMES_FIXTURE_REPO;
deps.channelRef = process.env.HERMES_FIXTURE_REF;
process.exit(await runHermes(process.argv.slice(2), deps));
