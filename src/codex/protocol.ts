/**
 * The subset of the Codex app-server protocol this bridge speaks.
 *
 * Copied by hand from `codex app-server generate-ts` (codex-cli 0.159.2),
 * keeping field names and shapes exactly as emitted; the generated tree is
 * 735 files and pulling it in wholesale would make every Codex release a
 * churn of files nobody here reads. `test/codex_protocol.test.ts` regenerates
 * the bindings when a `codex` binary is on PATH and checks that each shape
 * below still appears there verbatim, so drift is a failing test, not a
 * surprise at runtime.
 */

export type RequestId = string | number;

export type JsonValue = number | string | boolean | JsonValue[] | { [key: string]: JsonValue } | null;

export type ClientInfo = { name: string; title: string | null; version: string };

export type InitializeParams = {
  clientInfo: ClientInfo;
  capabilities: { experimentalApi: boolean; requestAttestation: boolean } | null;
};

export type InitializeResponse = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

export type AskForApproval = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ThreadStartParams = {
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  serviceName?: string | null;
  ephemeral?: boolean | null;
};

export type ThreadResumeParams = {
  threadId: string;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  excludeTurns?: boolean;
};

export type Thread = { id: string };
export type ThreadStartResponse = { thread: Thread; model: string };
export type ThreadResumeResponse = { thread: Thread; model: string };

export type UserInput = { type: "text"; text: string; text_elements: unknown[] };

export type TurnStartParams = { threadId: string; input: UserInput[] };

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type TurnError = { message: string };
export type Turn = { id: string; status: TurnStatus; error: TurnError | null };
export type TurnStartResponse = { turn: Turn };
export type TurnCompletedNotification = { threadId: string; turn: Turn };

export type GetAccountResponse = {
  account: { type: "apiKey" } | { type: "chatgpt"; email: string | null } | { type: string } | null;
  requiresOpenaiAuth: boolean;
};

/* Server → client requests ------------------------------------------------- */

export type CommandExecutionApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type CommandExecutionRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
};

export type FileChangeRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
};

export type PermissionsRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  permissions: JsonValue;
};

/** `scope` is `PermissionGrantScope`: "turn" | "session". */
export type PermissionsRequestApprovalResponse = { permissions: JsonValue; scope: "turn" | "session" };

export type McpServerElicitationRequestResponse = {
  action: "accept" | "decline" | "cancel";
  content: JsonValue | null;
  _meta: JsonValue | null;
};

/** The legacy (v1) approval answer, still sent by some code paths. */
export type ReviewDecision = "approved" | "approved_for_session" | { denied: { rejection: string } } | "abort";

export const SERVER_REQUESTS = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
  elicitation: "mcpServer/elicitation/request",
  userInput: "item/tool/requestUserInput",
  dynamicToolCall: "item/tool/call",
  authTokensRefresh: "account/chatgptAuthTokens/refresh",
  attestation: "attestation/generate",
  legacyApplyPatch: "applyPatchApproval",
  legacyExecCommand: "execCommandApproval",
} as const;
