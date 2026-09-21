import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

export type Commands = ProtocolMapping.Commands;
export type Events = ProtocolMapping.Events;

type Handler = (payload: any) => void;

export class CdpError extends Error {
  method: string;
  code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
    this.method = method;
    this.code = code;
  }
}

export class Session {
  readonly id: string | undefined;
  #conn: Connection;
  #handlers = new Map<string, Set<Handler>>();

  constructor(conn: Connection, id: string | undefined) {
    this.#conn = conn;
    this.id = id;
  }

  send<M extends keyof Commands>(
    method: M,
    ...params: Commands[M]["paramsType"]
  ): Promise<Commands[M]["returnType"]> {
    return this.#conn.rawSend(method, params[0], this.id);
  }

  on<E extends keyof Events>(event: E, handler: (payload: Events[E][0]) => void): () => void {
    let set = this.#handlers.get(event);
    if (!set) this.#handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  waitFor<E extends keyof Events>(
    event: E,
    opts: { predicate?: (payload: Events[E][0]) => boolean; timeout?: number } = {},
  ): Promise<Events[E][0]> {
    const timeout = opts.timeout ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(event, `event not received within ${timeout}ms`));
      }, timeout);
      const off = this.on(event, (payload) => {
        if (opts.predicate && !opts.predicate(payload)) return;
        clearTimeout(timer);
        off();
        resolve(payload);
      });
    });
  }

  emit(event: string, payload: unknown): void {
    const set = this.#handlers.get(event);
    if (set) for (const handler of [...set]) handler(payload);
  }
}

export class Connection {
  readonly root: Session;
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  #sessions = new Map<string, Session>();
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.root = new Session(this, undefined);
    ws.addEventListener("message", (ev) => this.#onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(new CdpError(p.method, "connection closed"));
      this.#pending.clear();
    });
  }

  static connect(wsUrl: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve(new Connection(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to Chrome at ${wsUrl}`)), { once: true });
    });
  }

  session(id: string): Session {
    let s = this.#sessions.get(id);
    if (!s) this.#sessions.set(id, (s = new Session(this, id)));
    return s;
  }

  rawSend(method: string, params: unknown, sessionId: string | undefined): Promise<any> {
    if (this.#closed) return Promise.reject(new CdpError(method, "connection closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }));
    });
  }

  close(): void {
    this.#closed = true;
    this.#ws.close();
  }

  #onMessage(data: string): void {
    const msg = JSON.parse(data);
    if (typeof msg.id === "number") {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.message, msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    const target = msg.sessionId ? this.#sessions.get(msg.sessionId) : this.root;
    target?.emit(msg.method, msg.params);
  }
}
