/**
 * The `suite-channel` MCP server Codex runs: `suite_reply`, `suite_typing`,
 * `suite_reply_chunk` and `suite_reply_with_media` — the same names and input
 * schemas as the Claude channel plugin, so an agent's habits carry over.
 *
 * WHY A SEPARATE PROCESS, AND HOW IT REACHES SUITE. Codex spawns stdio MCP
 * servers itself, so this runs as Codex's child (`suite codex --reply-mcp`),
 * not inside the bridge. It must not open its own runtime socket: one runtime
 * id with two sockets would split presence and dispatches between them. So it
 * forwards each call over a unix socket to the bridge, which owns the one
 * runtime connection and pushes the event. The socket lives in the agent's
 * state directory, created mode 0700, and carries no credential.
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export const BRIDGE_SOCKET_ENV = "SUITE_CODEX_BRIDGE_SOCKET";

export const TOOL_SPECS = [
  {
    name: "suite_reply",
    description:
      "Send a text reply into a Startup Suite space. Use this to answer a message that arrived via the channel. Pass the space_id attribute from the inbound <channel> tag.",
    inputSchema: {
      type: "object",
      properties: { space_id: { type: "string" }, content: { type: "string" } },
      required: ["space_id", "content"],
    },
  },
  {
    name: "suite_reply_with_media",
    description:
      "Send a text reply with base64-encoded file attachments (e.g. a screenshot or diagram). Use when a visual artifact belongs in the thread.",
    inputSchema: {
      type: "object",
      properties: {
        space_id: { type: "string" },
        content: { type: "string" },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: { filename: { type: "string" }, content_type: { type: "string" }, data: { type: "string" } },
            required: ["filename", "content_type", "data"],
          },
          minItems: 1,
        },
      },
      required: ["space_id", "content", "attachments"],
    },
  },
  {
    name: "suite_typing",
    description: "Toggle a typing indicator in the Suite space so humans can see that a reply is being composed.",
    inputSchema: {
      type: "object",
      properties: { space_id: { type: "string" }, typing: { type: "boolean" } },
      required: ["space_id", "typing"],
    },
  },
  {
    name: "suite_reply_chunk",
    description:
      "Send a partial reply chunk to a Suite space, appearing to the human as a progressively-revealed message. Call it several times with the same chunk_id, passing the cumulative text each call. Set done:true on the last call.",
    inputSchema: {
      type: "object",
      properties: {
        space_id: { type: "string" },
        chunk_id: { type: "string", description: "Stable id across all chunks of one reply." },
        text: { type: "string", description: "Cumulative reply text so far (not delta)." },
        done: { type: "boolean", description: "true on the final chunk, false otherwise." },
      },
      required: ["space_id", "chunk_id", "text", "done"],
    },
  },
] as const;

/* Bridge side -------------------------------------------------------------- */

export type ToolHandler = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;

/** Line-delimited JSON: `{id, tool, args}` in, `{id, ok, text}` out. */
export function listenBridgeSocket(path: string, handle: ToolHandler, log: (line: string) => void): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  rmSync(path, { force: true });
  const server = createServer((conn: Socket) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        let req: { id?: unknown; tool?: unknown; args?: unknown };
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const tool = String(req.tool ?? "");
        const args = (req.args ?? {}) as Record<string, unknown>;
        void handle(tool, args)
          .catch((e: unknown) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }))
          .then((r) => {
            log(`channel tool ${tool} → ${r.ok ? "ok" : `failed: ${r.text}`}`);
            conn.write(`${JSON.stringify({ id: req.id, ...r })}\n`);
          });
      }
    });
    conn.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

/* MCP side ----------------------------------------------------------------- */

interface McpIo {
  write(line: string): void;
  /** Forward a tool call to the bridge. */
  forward(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
}

/**
 * One MCP JSON-RPC 2.0 message → the response line, or null for a
 * notification. Pure apart from `forward`, so the protocol is tested without
 * a process.
 */
export async function handleMcpMessage(line: string, io: McpIo, version: string): Promise<string | null> {
  let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (msg.id === undefined || msg.method === undefined) return null;
  const ok = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: (msg.params?.protocolVersion as string | undefined) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "suite-channel", version },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOL_SPECS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOL_SPECS.some((t) => t.name === name)) {
        return JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
      }
      let r: { ok: boolean; text: string };
      try {
        r = await io.forward(name, args);
      } catch (e) {
        r = { ok: false, text: `the suite codex bridge is not reachable: ${e instanceof Error ? e.message : String(e)}` };
      }
      return ok({ content: [{ type: "text", text: r.text }], isError: !r.ok });
    }
    default:
      return JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

/** A forwarder over the bridge's unix socket. One connection, calls correlated by id. */
export function socketForwarder(path: string): (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> {
  let conn: Socket | null = null;
  let next = 1;
  const waiting = new Map<number, (r: { ok: boolean; text: string }) => void>();
  const open = (): Socket => {
    if (conn !== null && !conn.destroyed) return conn;
    const c = createConnection(path);
    let buf = "";
    c.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        try {
          const r = JSON.parse(buf.slice(0, nl)) as { id: number; ok: boolean; text: string };
          waiting.get(r.id)?.({ ok: r.ok, text: r.text });
          waiting.delete(r.id);
        } catch {
          /* ignore a malformed line */
        }
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    const fail = (why: string) => {
      for (const w of waiting.values()) w({ ok: false, text: `the suite codex bridge is not reachable: ${why}` });
      waiting.clear();
      conn = null;
    };
    c.on("error", (e) => fail(e.message));
    c.on("close", () => fail("connection closed"));
    conn = c;
    return c;
  };
  return (tool, args) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      open().write(`${JSON.stringify({ id, tool, args })}\n`);
    });
}

/** `suite codex --reply-mcp`: serve MCP on stdio until stdin closes. */
export async function runReplyMcp(env: Record<string, string | undefined>, version: string): Promise<number> {
  const path = env[BRIDGE_SOCKET_ENV];
  if (path === undefined || path === "") {
    process.stderr.write(`suite codex --reply-mcp: ${BRIDGE_SOCKET_ENV} is not set\n`);
    return 2;
  }
  const io: McpIo = { write: (l) => void process.stdout.write(`${l}\n`), forward: socketForwarder(path) };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      void handleMcpMessage(line, io, version).then((out) => {
        if (out !== null) io.write(out);
      });
    }
  }
  return 0;
}
