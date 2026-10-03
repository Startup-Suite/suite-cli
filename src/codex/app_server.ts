/**
 * A client for `codex app-server`: JSON-RPC over stdio, one JSON object per
 * line, no `"jsonrpc"` field (measured against codex-cli 0.159.2: responses
 * are `{"id":1,"result":…}`, notifications `{"method":…,"params":…}`).
 *
 * Three message kinds arrive from the server and each has one home:
 *
 *  - a RESPONSE (has `id`, has `result` or `error`) settles our request;
 *  - a NOTIFICATION (has `method`, no `id`) goes to `onNotification`;
 *  - a SERVER REQUEST (has `method` AND `id`) — an approval, an elicitation —
 *    goes to `onRequest`, whose answer is written back under the same id.
 *    An unanswered server request stalls the turn, so a handler that throws
 *    still produces a JSON-RPC error reply rather than silence.
 *
 * The protocol types in `./protocol.ts` are a hand-copied subset of what
 * `codex app-server generate-ts` emits for 0.159.2.
 */
import type { RequestId } from "./protocol.ts";

export interface Transport {
  /** Write one line (the client appends the newline). */
  write(line: string): void;
  /** Register the line reader. Each call gets exactly one complete line. */
  onLine(fn: (line: string) => void): void;
  /** Called once when the server's stdout ends (the process exited). */
  onClose(fn: (reason: string) => void): void;
  close(): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void };

export interface AppServerHandlers {
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, params: unknown, id: RequestId): Promise<unknown>;
  onClose?(reason: string): void;
}

export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private closed: string | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly handlers: AppServerHandlers,
  ) {
    transport.onLine((line) => this.receive(line));
    transport.onClose((reason) => {
      this.closed = reason;
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited: ${reason}`));
      this.pending.clear();
      handlers.onClose?.(reason);
    });
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed !== null) return Promise.reject(new Error(`codex app-server exited: ${this.closed}`));
    const id = this.nextId++;
    this.transport.write(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed !== null) return;
    this.transport.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  close(): void {
    this.transport.close();
  }

  private receive(line: string): void {
    if (line.trim() === "") return;
    let msg: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method !== undefined) {
      this.handlers.onNotification(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private async answer(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params, id);
      this.transport.write(JSON.stringify({ id, result }));
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      const message = error instanceof Error ? error.message : String(error);
      this.transport.write(JSON.stringify({ id, error: { code, message } }));
    }
  }
}

/** A transport over a spawned `codex app-server` child (bun). */
export function processTransport(proc: {
  stdin: { write(s: string): unknown; end?(): unknown; flush?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}): Transport {
  let lineFn: (line: string) => void = () => {};
  let closeFn: (reason: string) => void = () => {};
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        lineFn(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    const code = await proc.exited;
    closeFn(`exit ${code}`);
  })();
  return {
    write(line) {
      proc.stdin.write(`${line}\n`);
      proc.stdin.flush?.();
    },
    onLine(fn) {
      lineFn = fn;
    },
    onClose(fn) {
      closeFn = fn;
    },
    close() {
      try {
        proc.kill();
      } catch {
        /* gone */
      }
    },
  };
}
