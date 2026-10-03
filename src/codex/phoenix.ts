/**
 * A minimal Phoenix channels client: one socket, one channel, the v2 JSON
 * serializer, heartbeats, and reconnect with backoff.
 *
 * WHY NOT THE `phoenix` PACKAGE. The dsh federation plugin uses it, with `ws`
 * underneath, and installs both into the harness directory. suite-cli itself
 * ships with no runtime dependencies beyond bun, and bun has a WebSocket. The
 * part of Phoenix this needs is small and fixed: the wire format is
 * `[join_ref, ref, topic, event, payload]`, a heartbeat is a push on the
 * `phoenix` topic, and a join is a `phx_join` whose `phx_reply` says ok or
 * error. That is what is implemented — no presence, no multiple channels.
 *
 * The URL shape matches what the Phoenix JS client builds from the same
 * endpoint (`<endpoint>/websocket?<params>&vsn=2.0.0`), so the server sees
 * exactly what the existing channel plugins send.
 */

export type Payload = Record<string, unknown>;

/** The subset of the WebSocket API used here, so a test can inject a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const HEARTBEAT_MS = 30_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
const OPEN = 1;

/**
 * `<ws endpoint>/websocket?runtime_id=…&token=…&vsn=2.0.0`.
 *
 * The token rides in the query string because that is where the runtime
 * socket reads it (`RuntimeSocket.connect/3`); every existing plugin does the
 * same. It is never logged: {@link redactUrl} is what goes into a log line.
 */
export function socketUrl(endpoint: string, params: Record<string, string>): string {
  const u = new URL(endpoint);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/websocket`;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("vsn", "2.0.0");
  return u.toString();
}

export function redactUrl(url: string): string {
  const u = new URL(url);
  if (u.searchParams.has("token")) u.searchParams.set("token", "REDACTED");
  return u.toString();
}

export interface PhoenixOptions {
  url: string;
  topic: string;
  joinPayload: Payload;
  socket: SocketFactory;
  log(line: string): void;
  /** Injected so tests do not wait real seconds. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  heartbeatMs?: number;
}

/**
 * Connects, joins, and stays joined. `on(event, fn)` receives server pushes on
 * the topic; `push(event, payload)` sends one (dropped, and said so, while not
 * joined — a reply cannot be queued across a reconnect without risking a
 * duplicate post).
 */
export class PhoenixChannel {
  private ws: SocketLike | null = null;
  private ref = 0;
  private joinRef: string | null = null;
  private joined = false;
  private stopped = false;
  private attempts = 0;
  private heartbeat: unknown = null;
  private reconnect: unknown = null;
  private readonly handlers = new Map<string, ((payload: Payload) => void)[]>();
  private readonly replies = new Map<string, (status: string, response: Payload) => void>();
  private readonly onJoinedFns: (() => void)[] = [];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: PhoenixOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get isJoined(): boolean {
    return this.joined;
  }

  on(event: string, fn: (payload: Payload) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }

  onJoined(fn: () => void): void {
    this.onJoinedFns.push(fn);
  }

  connect(): void {
    if (this.stopped) return;
    this.opts.log(`connecting to ${redactUrl(this.opts.url)}`);
    const ws = this.opts.socket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.startHeartbeat();
      this.join();
    };
    ws.onmessage = (ev) => this.receive(String(ev.data));
    ws.onerror = () => this.opts.log("socket error");
    ws.onclose = () => {
      this.joined = false;
      this.stopHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  /** Send one event. Resolves with the server's reply status, or "dropped". */
  push(event: string, payload: Payload): Promise<{ status: string; response: Payload }> {
    if (!this.joined || this.ws === null || this.ws.readyState !== OPEN) {
      this.opts.log(`not joined; dropped ${event}`);
      return Promise.resolve({ status: "dropped", response: {} });
    }
    const ref = this.nextRef();
    this.send([this.joinRef, ref, this.opts.topic, event, payload]);
    return new Promise((resolve) => {
      this.replies.set(ref, (status, response) => resolve({ status, response }));
      // A reply that never comes must not hold a caller forever.
      this.setTimer(() => {
        if (this.replies.delete(ref)) resolve({ status: "timeout", response: {} });
      }, 10_000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnect !== null) this.clearTimer(this.reconnect);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private send(frame: unknown[]): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private join(): void {
    this.joinRef = this.nextRef();
    const ref = this.joinRef;
    this.send([ref, ref, this.opts.topic, "phx_join", this.opts.joinPayload]);
    this.replies.set(ref, (status, response) => {
      if (status === "ok") {
        this.joined = true;
        this.opts.log(`joined ${this.opts.topic}`);
        for (const fn of this.onJoinedFns) fn();
      } else {
        this.opts.log(`join refused: ${JSON.stringify(response)}`);
        try {
          this.ws?.close();
        } catch {
          /* closing anyway */
        }
      }
    });
  }

  private receive(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length !== 5) return;
    const [, ref, topic, event, payload] = frame as [string | null, string | null, string, string, Payload];
    if (event === "phx_reply" && ref !== null) {
      const fn = this.replies.get(ref);
      if (fn !== undefined) {
        this.replies.delete(ref);
        const p = (payload ?? {}) as { status?: string; response?: Payload };
        fn(p.status ?? "error", p.response ?? {});
      }
      return;
    }
    if (topic !== this.opts.topic) return;
    if (event === "phx_close" || event === "phx_error") {
      this.joined = false;
      this.opts.log(`channel ${event}; rejoining`);
      this.join();
      return;
    }
    for (const fn of this.handlers.get(event) ?? []) fn(payload ?? {});
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => {
      this.send([null, this.nextRef(), "phoenix", "heartbeat", {}]);
      this.heartbeat = this.setTimer(beat, this.opts.heartbeatMs ?? HEARTBEAT_MS);
    };
    this.heartbeat = this.setTimer(beat, this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.clearTimer(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnect !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    this.attempts += 1;
    this.opts.log(`socket closed; reconnecting in ${delay}ms`);
    this.reconnect = this.setTimer(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
  }
}
