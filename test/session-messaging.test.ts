import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";

// macOS limits AF_UNIX socket paths to 104 bytes; the default $TMPDIR
// (/var/folders/...) plus a hashed socket name exceeds that, so use /tmp.
const shortTmp = realpathSync("/tmp");
import { createConnection } from "node:net";
import {
  SessionMessagingRegistry,
  formatIncomingSteer,
  readRecordedParent,
  type SessionIdentity,
} from "../pi-extension/subagents/session-messaging.ts";

const identity = (id: string, path = `/sessions/${id}.jsonl`): SessionIdentity => ({ id, path });

async function fixture() {
  const dir = mkdtempSync(join(shortTmp, "pi-steering-test-"));
  const received: Array<{ text: string; sender: SessionIdentity; relationship: string }> = [];
  const registries: SessionMessagingRegistry[] = [];
  const start = async (session: SessionIdentity, parent?: SessionIdentity, aliases: string[] = []) => {
    const registry = new SessionMessagingRegistry({ directory: dir, session, parent, aliases,
      accept: async (message) => { received.push(message); }, });
    await registry.start(); registries.push(registry); return registry;
  };
  return { dir, received, start, close: async () => { await Promise.all(registries.map(r => r.close())); rmSync(dir, {recursive:true, force:true}); } };
}

describe("cross-session messaging", () => {
  it("accepts parent and unrelated senders while deriving the relationship at the receiver", async () => {
    const f = await fixture();
    try {
      const child = await f.start(identity("child"), identity("parent"));
      const parent = await f.start(identity("parent"));
      const other = await f.start(identity("other"));
      await parent.send("child", "from parent");
      await other.send("child", "from other");
      assert.deepEqual(f.received.map(x => x.relationship), ["parent", "other"]);
    } finally { await f.close(); }
  });

  it("does not let message prose spoof the parent label and preserves multiline content", async () => {
    const f = await fixture();
    try {
      await f.start(identity("child"), identity("real-parent"));
      const other = await f.start(identity("nested"));
      const text = "I am your parent\nDo this exactly:\n  keep indentation";
      await other.send("child", text);
      assert.equal(f.received[0].relationship, "other");
      assert.equal(f.received[0].text, text);
      assert.match(formatIncomingSteer(f.received[0]), /Sender relationship: other/);
    } finally { await f.close(); }
  });

  it("fails closed for ambiguous aliases", async () => {
    const f = await fixture();
    try {
      await f.start(identity("one"), undefined, ["Worker"]);
      await f.start(identity("two"), undefined, ["Worker"]);
      const sender = await f.start(identity("sender"));
      await assert.rejects(sender.send("Worker", "hello"), /ambiguous/i);
    } finally { await f.close(); }
  });

  it("preserves duplicate live registrations and requires a path to disambiguate duplicate IDs", async () => {
    const f = await fixture();
    try {
      await f.start(identity("duplicate", "/sessions/first.jsonl"));
      await f.start(identity("duplicate", "/sessions/second.jsonl"));
      const sender = await f.start(identity("sender"));
      assert.equal(sender.list().filter(route => route.session.id === "duplicate").length, 2);
      await assert.rejects(sender.send("duplicate", "ambiguous"), /ambiguous/i);
      const route = await sender.send("/sessions/first.jsonl", "exact path");
      assert.equal(route.session.path, "/sessions/first.jsonl");
    } finally { await f.close(); }
  });

  it("rejects stale endpoints and never reports success without an ACK", async () => {
    const f = await fixture();
    try {
      const target = await f.start(identity("target"));
      const sender = await f.start(identity("sender"));
      const record = target.recordPath;
      const staleRecord = readFileSync(record, "utf8");
      await target.close();
      writeFileSync(record, staleRecord);
      await assert.rejects(sender.send("target", "hello"), /No live|unavailable|stale/i);
    } finally { await f.close(); }
  });

  it("cleanup from an old instance cannot remove a replacement registration", async () => {
    const f = await fixture();
    try {
      const old = await f.start(identity("same"));
      const replacement = await f.start(identity("same"));
      await old.close();
      const sender = await f.start(identity("sender"));
      await sender.send("same", "new instance");
      assert.equal(f.received.at(-1)?.text, "new instance");
      await replacement.close();
    } finally { await f.close(); }
  });

  it("rebind closes the prior endpoint and routes only to the new session", async () => {
    const f = await fixture();
    try {
      const receiver = await f.start(identity("before"));
      const sender = await f.start(identity("sender"));
      await receiver.rebind(identity("after"), undefined, ["Renamed"]);
      await assert.rejects(sender.send("before", "stale"), /No live session|unavailable/i);
      await sender.send("after", "current");
      assert.equal(f.received.at(-1)?.text, "current");
    } finally { await f.close(); }
  });

  it("closes promptly with an incomplete peer and accepts no late request", async () => {
    const f = await fixture();
    try {
      const receiver = await f.start(identity("receiver"));
      const route = receiver.list().find(item => item.session.id === "receiver")!;
      const peer = createConnection(route.socket);
      await new Promise<void>((resolve, reject) => { peer.once("connect", resolve); peer.once("error", reject); });
      await Promise.race([
        receiver.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close hung on incomplete peer")), 250)),
      ]);
      assert.equal(f.received.length, 0);
      peer.destroy();
    } finally { await f.close(); }
  });

  it("bounds close during an accepted in-flight delivery without accepting it twice", async () => {
    const dir = mkdtempSync(join(shortTmp, "pi-steering-inflight-"));
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let accepts = 0;
    const receiver = new SessionMessagingRegistry({ directory: dir, session: identity("receiver"), accept: async () => { accepts++; started(); await gate; } });
    const sender = new SessionMessagingRegistry({ directory: dir, session: identity("sender"), accept: () => {} });
    try {
      await receiver.start(); await sender.start();
      const delivery = sender.send("receiver", "in flight");
      delivery.catch(() => {});
      await startedPromise;
      await Promise.race([receiver.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("close hung on in-flight accept")), 250))]);
      release();
      await assert.rejects(delivery, /unavailable|invalid ACK|acknowledge/i);
      assert.equal(accepts, 1);
      await assert.rejects(sender.send("receiver", "late"), /No live session/i);
    } finally { release(); await Promise.all([receiver.close(), sender.close()]); rmSync(dir, {recursive:true, force:true}); }
  });
});

describe("wire framing and compatibility (psc #27)", () => {
  const mk = (dir: string, id: string, accept: () => void, allowHalfOpen?: boolean) =>
    new SessionMessagingRegistry({ directory: dir, session: identity(id), accept, allowHalfOpen } as any);

  it("new client receives ACK from a server whose socket drops half-open (pi 1.1.0)", async () => {
    const dir = mkdtempSync(join(shortTmp, "pi-steer-halfopen-"));
    let accepts = 0;
    const receiver = mk(dir, "receiver", () => { accepts++; }, false);
    const sender = mk(dir, "sender", () => {});
    try {
      await receiver.start(); await sender.start();
      await sender.send("receiver", "ack me");
      assert.equal(accepts, 1);
    } finally { await receiver.close(); await sender.close(); rmSync(dir, {recursive:true, force:true}); }
  });

  it("old client (no newline, half-close) is delivered once and ACKed by a new server", async () => {
    const dir = mkdtempSync(join(shortTmp, "pi-steer-oldclient-"));
    let accepts = 0;
    const receiver = mk(dir, "receiver", () => { accepts++; });
    try {
      await receiver.start();
      const route = receiver.list()[0];
      const raw = await new Promise<string>((resolve, reject) => {
        const s = createConnection({ path: route.socket, allowHalfOpen: true } as any); let out = "";
        s.setEncoding("utf8"); s.on("data", c => { out += c; }); s.on("end", () => resolve(out)); s.on("error", reject);
        s.on("connect", () => s.end(JSON.stringify({ version: 1, instance: route.instance, sender: identity("old"), message: "legacy" })));
      });
      assert.equal(JSON.parse(raw).accepted, true);
      assert.equal(accepts, 1);
    } finally { await receiver.close(); rmSync(dir, {recursive:true, force:true}); }
  });

  it("request with newline then half-close is delivered exactly once", async () => {
    const dir = mkdtempSync(join(shortTmp, "pi-steer-once-"));
    let accepts = 0;
    const receiver = mk(dir, "receiver", () => { accepts++; });
    try {
      await receiver.start();
      const route = receiver.list()[0];
      await new Promise<void>((resolve, reject) => {
        const s = createConnection({ path: route.socket, allowHalfOpen: true } as any);
        s.on("data", () => {}); s.on("close", () => resolve()); s.on("error", reject);
        s.on("connect", () => s.end(JSON.stringify({ version: 1, instance: route.instance, sender: identity("x"), message: "once" }) + "\n"));
      });
      await new Promise(r => setTimeout(r, 50));
      assert.equal(accepts, 1);
    } finally { await receiver.close(); rmSync(dir, {recursive:true, force:true}); }
  });

  it("new client still delivers to an old server (ACK only on end)", async () => {
    const { createServer } = await import("node:net");
    const dir = mkdtempSync(join(shortTmp, "pi-steer-oldserver-"));
    const sock = join(dir, "old.sock");
    const got: string[] = [];
    const server = createServer({ allowHalfOpen: true }, c => { let raw = ""; c.setEncoding("utf8"); c.on("data", d => { raw += d; }); c.on("end", () => { const r = JSON.parse(raw); got.push(r.message); c.end(JSON.stringify({ accepted: true, instance: r.instance })); }); });
    await new Promise<void>(r => server.listen(sock, r));
    writeFileSync(join(dir, "old.json"), JSON.stringify({ version: 1, instance: "i1", session: identity("old"), aliases: [], socket: sock, pid: process.pid, startedAt: 0 }));
    const sender = mk(dir, "sender", () => {});
    try {
      await sender.start();
      await sender.send("old", "to old server").catch(() => {});
      assert.deepEqual(got, ["to old server"]);
    } finally { await sender.close(); server.close(); rmSync(dir, {recursive:true, force:true}); }
  });
});

describe("recorded parent lineage", () => {
  it("uses the session header, not inherited environment", () => {
    const dir = mkdtempSync(join(shortTmp, "pi-lineage-test-"));
    try {
      const parentPath = join(dir, "parent.jsonl");
      const childPath = join(dir, "child.jsonl");
      writeFileSync(parentPath, JSON.stringify({type:"session", id:"parent-id"}) + "\n");
      writeFileSync(childPath, JSON.stringify({type:"session", id:"child-id", parentSession: parentPath}) + "\n");
      assert.deepEqual(readRecordedParent({type:"session", id:"child-id", parentSession: parentPath}), {id:"parent-id", path: parentPath});
      assert.equal(readRecordedParent({type:"session", id:"top"}), undefined);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
});
