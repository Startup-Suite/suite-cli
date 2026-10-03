/**
 * DRIFT CHECK: the hand-copied protocol subset in src/codex/protocol.ts, and
 * the methods the bridge calls, against what the installed Codex generates
 * (`codex app-server generate-ts`). A Codex release that renames a method or
 * field the bridge depends on fails here, by name, instead of at 3am in a
 * pane nobody is watching. Skipped (and said so) without a `codex` on PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_REQUESTS } from "../src/codex/protocol.ts";

const CODEX = Bun.which("codex");
const OUT = mkdtempSync(join(tmpdir(), "suite-codex-proto-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

const read = (rel: string): string => readFileSync(join(OUT, rel), "utf8");

describe.if(CODEX !== null)("the bridge's protocol subset matches the installed codex", () => {
  test("generate-ts runs", () => {
    const r = Bun.spawnSync([CODEX as string, "app-server", "generate-ts", "--out", OUT], { env: { ...process.env, CODEX_HOME: OUT } });
    expect(r.exitCode).toBe(0);
  });

  test("every client method the bridge or its tests call exists", () => {
    const src = read("ClientRequest.ts");
    for (const m of ["initialize", "thread/start", "thread/resume", "turn/start", "account/read", "mcpServerStatus/list", "mcpServer/tool/call"]) {
      expect(src).toContain(`"method": "${m}"`);
    }
  });

  test("every server request the bridge answers exists", () => {
    const src = read("ServerRequest.ts");
    for (const m of Object.values(SERVER_REQUESTS)) expect(src).toContain(`"method": "${m}"`);
  });

  test("the notifications the bridge listens for exist", () => {
    const src = read("ServerNotification.ts");
    for (const m of ["turn/completed", "error"]) expect(src).toContain(`"method": "${m}"`);
  });

  test("the fields the bridge sends and reads exist with the same names", () => {
    const has = (file: string, ...needles: string[]) => {
      const src = read(file);
      for (const n of needles) expect({ file, n, found: src.includes(n) }).toEqual({ file, n, found: true });
    };
    has("v2/ThreadStartParams.ts", "cwd?:", "approvalPolicy?:", "sandbox?:", "developerInstructions?:", "serviceName?:");
    has("v2/ThreadResumeParams.ts", "threadId: string", "excludeTurns?: boolean");
    has("v2/TurnStartParams.ts", "threadId: string", "input: Array<UserInput>");
    has("v2/UserInput.ts", '"type": "text", text: string', "text_elements:");
    has("v2/TurnCompletedNotification.ts", "threadId: string, turn: Turn");
    has("v2/TurnStatus.ts", '"completed" | "interrupted" | "failed" | "inProgress"');
    has("v2/CommandExecutionApprovalDecision.ts", '"accept"', '"decline"');
    has("v2/FileChangeApprovalDecision.ts", '"accept"', '"decline"');
    has("v2/PermissionsRequestApprovalResponse.ts", "permissions: GrantedPermissionProfile", "scope: PermissionGrantScope");
    has("v2/McpServerElicitationRequestResponse.ts", "action: McpServerElicitationAction", "content: JsonValue | null", "_meta: JsonValue | null");
    has("v2/ToolRequestUserInputResponse.ts", "answers:");
    has("ReviewDecision.ts", '"approved"', '"denied": { rejection: string');
    has("v2/AskForApproval.ts", '"on-request"', '"never"');
    has("v2/SandboxMode.ts", '"read-only" | "workspace-write" | "danger-full-access"');
  });
});
