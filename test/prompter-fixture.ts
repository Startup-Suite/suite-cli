/**
 * Fixture driven by test/secrets.test.ts as a REAL child process.
 *
 * The defect it exists to detect only appears against the process-global
 * `process.stdin`: an in-process fake stream would not reproduce it. So this
 * runs `ttyPrompter()` for real and asks three questions, printing each answer
 * on its own line as `answer:<value>` and any failure as `error:<message>`.
 */
import { ttyPrompter } from "../src/secrets.ts";

const prompter = ttyPrompter();

try {
  for (const question of ["one? ", "two? ", "three? "]) {
    const answer = await prompter.ask(question);
    process.stdout.write(`answer:${answer}\n`);
  }
} catch (err) {
  process.stdout.write(`error:${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
