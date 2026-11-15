import { createServer, createConnection, type Server, type Socket } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface SessionIdentity { id: string; path?: string }
export interface IncomingSteer { text: string; sender: SessionIdentity; relationship: "parent" | "other" }
export interface RouteRecord { version: 1; instance: string; session: SessionIdentity; aliases: string[]; socket: string; pid: number; startedAt: number }
interface Request { version: 1; instance: string; sender: SessionIdentity; message: string }
type Ack = { accepted: true; instance: string } | { accepted: false; error: string };

const DEFAULT_DIRECTORY = join(homedir(), ".pi", "agent", "session-messaging");
const MAX_REQUEST_BYTES = 1024 * 1024;
const ACK_TIMEOUT_MS = 2_000;

function key(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function sameIdentity(a: SessionIdentity, b?: SessionIdentity): boolean {
  if (!b) return false;
  return a.id === b.id && (!a.path || !b.path || resolve(a.path) === resolve(b.path));
}
function normalizeIdentity(value: SessionIdentity): SessionIdentity {
  return { id: value.id, ...(value.path ? { path: resolve(value.path) } : {}) };
}

export function readRecordedParent(header: unknown): SessionIdentity | undefined {
  const record = header as { parentSession?: unknown } | null;
  if (!record || typeof record.parentSession !== "string" || !record.parentSession) return undefined;
  const path = resolve(record.parentSession);
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    const parent = JSON.parse(first);
    if (parent?.type === "session" && typeof parent.id === "string") return { id: parent.id, path };
  } catch { /* Missing or malformed lineage is unknown, never guessed. */ }
  return undefined;
}

export function formatIncomingSteer(message: IncomingSteer): string {
  return `[Cross-session steer]\nSender session: ${message.sender.id}${message.sender.path ? ` (${message.sender.path})` : ""}\nSender relationship: ${message.relationship}\n\n${message.text}`;
}

export class SessionMessagingRegistry {
  private server?: Server;
  private connections = new Set<Socket>();
  private closing = false;
  private instance = randomUUID();
  private session: SessionIdentity;
  private parent?: SessionIdentity;
  private aliases: string[];
  readonly directory: string;
  readonly accept: (message: IncomingSteer) => Promise<void> | void;

  constructor(options: { directory?: string; session: SessionIdentity; parent?: SessionIdentity; aliases?: string[]; accept: (message: IncomingSteer) => Promise<void> | void }) {
    this.directory = options.directory ?? DEFAULT_DIRECTORY;
    this.session = normalizeIdentity(options.session);
    this.parent = options.parent && normalizeIdentity(options.parent);
    this.aliases = [...new Set(options.aliases ?? [])].filter(Boolean);
    this.accept = options.accept;
  }

  get recordPath(): string { return join(this.directory, `${key(this.instance)}.json`); }
  private get socketPath(): string { return join(this.directory, `${key(this.instance)}.sock`); }

  async start(): Promise<void> {
    if (this.server) return;
    this.closing = false;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { chmodSync(this.directory, 0o700); } catch {}
    const socket = this.socketPath;
    rmSync(socket, { force: true });
    const server = createServer({ allowHalfOpen: true }, (connection) => {
      if (this.closing) { connection.destroy(); return; }
      this.connections.add(connection);
      connection.once("close", () => this.connections.delete(connection));
      connection.setTimeout(ACK_TIMEOUT_MS, () => connection.destroy());
      let raw = "";
      connection.on("error", () => { /* Peer/protocol failures must not crash the Pi receiver. */ });
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => {
        raw += chunk;
        if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) connection.destroy(new Error("request too large"));
      });
      connection.on("end", async () => {
        let ack: Ack;
        try {
          if (this.closing) throw new Error("receiver is shutting down");
          const request = JSON.parse(raw) as Request;
          if (request.version !== 1 || request.instance !== this.instance) throw new Error("stale receiver instance");
          if (!request.sender || typeof request.sender.id !== "string" || typeof request.message !== "string" || !request.message.trim()) throw new Error("invalid steer request");
          const sender = normalizeIdentity(request.sender);
          await this.accept({ text: request.message, sender, relationship: sameIdentity(sender, this.parent) ? "parent" : "other" });
          ack = { accepted: true, instance: this.instance };
        } catch (error: any) { ack = { accepted: false, error: error?.message ?? String(error) }; }
        connection.end(JSON.stringify(ack));
      });
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(socket, () => { server.off("error", reject); resolvePromise(); });
    });
    try { chmodSync(socket, 0o600); } catch {}
    this.server = server;
    this.publish();
  }

  private publish(): void {
    const record: RouteRecord = { version: 1, instance: this.instance, session: this.session, aliases: this.aliases, socket: this.socketPath, pid: process.pid, startedAt: Date.now() };
    const temp = `${this.recordPath}.${this.instance}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, this.recordPath);
  }

  async rebind(session: SessionIdentity, parent?: SessionIdentity, aliases: string[] = []): Promise<void> {
    await this.close();
    this.instance = randomUUID();
    this.session = normalizeIdentity(session);
    this.parent = parent && normalizeIdentity(parent);
    this.aliases = [...new Set(aliases)].filter(Boolean);
    await this.start();
  }

  async close(): Promise<void> {
    this.closing = true;
    const server = this.server;
    this.server = undefined;
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
    if (server) await new Promise<void>((done) => server.close(() => done()));
    rmSync(this.socketPath, { force: true });
    rmSync(this.recordPath, { force: true });
  }

  list(): RouteRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(name => name.endsWith(".json")).flatMap(name => {
      try {
        const value = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as RouteRecord;
        if (value?.version !== 1 || typeof value.instance !== "string" || typeof value.session?.id !== "string") return [];
        try { process.kill(value.pid, 0); } catch { return []; }
        return [value];
      } catch { return []; }
    });
  }

  async send(target: string, message: string): Promise<RouteRecord> {
    if (!message.trim()) throw new Error("Steering message cannot be empty.");
    const exactPath = target.startsWith("/") ? resolve(target) : undefined;
    const routes = this.list();
    const matches = exactPath
      ? routes.filter(route => route.session.path === exactPath)
      : routes.some(route => route.session.id === target)
        ? routes.filter(route => route.session.id === target)
        : routes.filter(route => route.aliases.includes(target));
    if (matches.length === 0) throw new Error(`No live session matches "${target}".`);
    if (matches.length > 1) throw new Error(`Target "${target}" is ambiguous; use an exact session ID or path.`);
    const route = matches[0];
    const request: Request = { version: 1, instance: route.instance, sender: this.session, message };
    return await new Promise<RouteRecord>((resolvePromise, reject) => {
      const socket = createConnection(route.socket);
      let raw = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Session "${target}" did not acknowledge the steer.`)); }, ACK_TIMEOUT_MS);
      const fail = (error: Error) => { clearTimeout(timer); reject(new Error(`Session "${target}" is unavailable or stale: ${error.message}`)); };
      socket.setEncoding("utf8");
      socket.once("error", fail);
      socket.on("data", chunk => { raw += chunk; });
      socket.on("connect", () => socket.end(JSON.stringify(request)));
      socket.on("end", () => {
        clearTimeout(timer);
        try {
          const ack = JSON.parse(raw) as Ack;
          if (!ack.accepted) return reject(new Error(`Receiver rejected steer: ${ack.error}`));
          if (ack.instance !== route.instance) return reject(new Error("Receiver ACK came from a different instance."));
          resolvePromise(route);
        } catch (error: any) { reject(new Error(`Session "${target}" returned an invalid ACK: ${error?.message ?? error}`)); }
      });
    });
  }
}
