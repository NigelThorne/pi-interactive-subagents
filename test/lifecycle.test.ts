import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import * as lifecycle from "../pi-extension/subagents/lifecycle.ts";
import * as launch from "../pi-extension/subagents/launch.ts";

let id = 0;
const message = (role: string, text = "Result", stopReason = "stop") => ({
  type: "message", id: String(++id), message: { role, content: [{ type: "text", text }], stopReason },
});
const event = (name: string, customType = "timeline-telemetry") => ({
  type: "custom", id: String(++id), customType, data: { event: name },
});

// No Pi runtime or terminal dependencies: invoke the registered handlers with a controlled runtime.
function runtime(autoExit = true) {
  const handlers = new Map<string, Function>();
  const state = { entries: [] as any[], idle: false, pending: false, shutdowns: 0 };
  let tick: Function | undefined;
  let cleared = false;
  const ctx = {
    sessionManager: { getBranch: () => [...state.entries] },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    shutdown: () => { state.shutdowns++; },
  };
  lifecycle.registerAutoExit({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    appendEntry: (customType: string, data: any) => state.entries.push({ type: "custom", id: String(++id), customType, data }),
  } as any, autoExit, undefined, {
    setInterval: (fn: Function) => { tick = fn; return 1 as any; },
    clearInterval: () => { cleared = true; },
  });
  return { state, ctx, emit: (name: string) => handlers.get(name)?.({}, ctx), tick: () => tick?.(), cleared: () => cleared };
}

describe("unattended lifecycle", () => {
  it("ignores trailing telemetry but requires settled evidence, not merely assistant stop", () => {
    const entries = [message("assistant"), event("turn_end")];
    assert.equal(lifecycle.getSettledCompletion(entries), null);
    entries.push(event("agent_settled"), event("presence_published", "pi-session-manager-presence"));
    assert.equal(lifecycle.getSettledCompletion(entries)?.completion.status, "reported");
  });

  it("accepts the category-specific observer when global timeline telemetry is absent", () => {
    const entries = [message("assistant", "", "error"), event("settled", "subagent_runtime_model")];
    assert.equal(lifecycle.getSettledCompletion(entries)?.completion.status, "failed");
  });

  it("invalidates settlement when new work begins", () => {
    const entries = [message("assistant"), event("agent_settled")];
    for (const next of [message("user"), event("agent_start"), event("turn_start"), { type: "custom_message", id: "followup" }]) {
      assert.equal(lifecycle.getSettledCompletion([...entries, next]), null);
    }
  });

  it("does not confuse an old resumed task with the current task", () => {
    const entries = [message("assistant"), event("agent_settled")];
    assert.equal(lifecycle.getSettledCompletion(entries.slice(entries.length)), null);
    assert.equal(lifecycle.getSettledCompletion([...entries, message("user")]), null);
  });

  it("reports error, abort, truncation and missing output as failures", () => {
    for (const reason of ["error", "aborted", "length", "toolUse"]) {
      const entries = [message("assistant", "", reason), event("agent_settled")];
      const result = lifecycle.getSettledCompletion(entries)?.completion;
      assert.equal(result?.status, "failed");
      assert.match(result!.summary, new RegExp(reason));
    }
    assert.equal(lifecycle.completionFromEntries([]).status, "failed");
  });

  it("preserves blocked results and never substitutes a prior success for a current error", () => {
    const explicit = { status: "blocked" as const, summary: "Need parent approval" };
    assert.deepEqual(lifecycle.completionFromEntries([message("assistant", "Done.")], explicit), explicit);
    const failure = message("assistant", "", "error");
    (failure.message as any).errorMessage = "Provider unavailable";
    const result = lifecycle.completionFromEntries([message("assistant", "Old success"), failure], explicit);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /Provider unavailable/);
    assert.doesNotMatch(result.summary, /Old success/);
  });

  it("does not close at startup or at low-level agent_end", () => {
    const r = runtime();
    r.state.entries.push(message("assistant", "Historical success"));
    r.emit("session_start"); r.state.idle = true; r.tick();
    assert.equal(r.state.shutdowns, 0);
    r.emit("agent_start"); r.state.idle = false; r.emit("agent_end"); r.tick();
    assert.equal(r.state.shutdowns, 0);
    r.emit("session_shutdown"); assert.equal(r.cleared(), true);
  });

  it("closes a settled task without subagent_done and preserves its report", () => {
    const r = runtime(); r.emit("session_start"); r.emit("agent_start");
    r.state.entries.push(message("assistant", "Blocked: missing access"));
    r.state.idle = true; r.emit("agent_settled"); r.tick();
    assert.equal(r.state.shutdowns, 1);
    const result = lifecycle.getSettledCompletion(r.state.entries)?.completion;
    assert.equal(result?.summary, "Blocked: missing access");
    assert.equal(result?.status, "reported");
    r.emit("session_shutdown");
  });

  it("rescues a missed settled callback but not pending work", () => {
    const r = runtime(); r.emit("session_start"); r.emit("agent_start");
    r.state.entries.push(message("assistant")); r.state.idle = true; r.state.pending = true;
    r.tick(); assert.equal(r.state.shutdowns, 0);
    r.state.pending = false; r.tick(); assert.equal(r.state.shutdowns, 1);
    r.emit("session_shutdown");
  });

  it("settled abort exits with a failure rather than remaining unattended", () => {
    const r = runtime(); r.emit("session_start"); r.emit("agent_start");
    r.state.entries.push(message("assistant", "", "aborted")); r.state.idle = true;
    r.emit("agent_settled");
    assert.equal(r.state.shutdowns, 1);
    assert.equal(lifecycle.getSettledCompletion(r.state.entries)?.completion.status, "failed");
    r.emit("session_shutdown");
  });

  it("does not install auto-exit for interactive agents", () => {
    const r = runtime(false); r.emit("session_start"); r.emit("agent_start");
    r.state.idle = true; r.emit("agent_settled"); r.tick();
    assert.equal(r.state.shutdowns, 0);
  });

  it("persists explicit status and summary separately from the process exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-"));
    try {
      const done = join(dir, "agent.done");
      const result = { status: "blocked" as const, summary: "Need permission" };
      lifecycle.writeCompletion(`${done}.summary`, result);
      assert.deepEqual(lifecycle.readCompletion(done), result);
      assert.equal(readFileSync(`${done}.summary`, "utf8"), result.summary);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("parent result reporting", () => {
  it("keeps an explicit blocked outcome separate from a nonzero process exit", () => {
    const source = readFileSync(new URL("../pi-extension/subagents/index.ts", import.meta.url), "utf8");
    const start = source.indexOf("    const status =", source.indexOf("const legacySummary"));
    const end = source.indexOf("\n    try {\n      closeSurface", start);
    assert.ok(start > 0 && end > start);
    const report = new Function("exitCode", "completion", source.slice(start, end) + "\nreturn { status, summary };");
    const result = report(17, { status: "blocked", summary: "Need approval" });
    assert.equal(result.status, "blocked");
    assert.match(result.summary, /17/);
    assert.match(result.summary, /Need approval/);
  });
});

describe("launch completion contract", () => {
  it("explicitly enables task resumes and disables inherited auto-exit for manual resumes", () => {
    assert.equal(launch.autoExitEnv(true), "PI_SUBAGENT_AUTO_EXIT=1");
    assert.equal(launch.autoExitEnv(false), "PI_SUBAGENT_AUTO_EXIT=0");
    assert.equal(launch.resumeAutoExit("follow-up"), true);
    assert.equal(launch.resumeAutoExit(undefined), false);
    assert.equal(launch.resumeAutoExit("  "), false);
  });

  it("keeps completion available without widening the task tool allowlist", () => {
    assert.equal(launch.completionTools("read, grep, read, write_artifact"), "read,grep,write_artifact,subagent_done");
    assert.equal(launch.completionTools("read,subagent_done"), "read,subagent_done");
    assert.equal(launch.completionTools(undefined), undefined);
    assert.equal(launch.completionTools(""), "subagent_done");
  });

  it("captures the Pi exit code before removing the resume prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "exit-status-"));
    try {
      const done = join(dir, "agent.done");
      const cleanup = join(dir, "prompt ' file");
      execFileSync("sh", ["-c", launch.wrapChildCommand("sh -c 'exit 17'", done, cleanup)]);
      assert.equal(readFileSync(done, "utf8").trim(), "17");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("child pi executable", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "pi-exe-"));
    const make = (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "#!/bin/sh\n");
      chmodSync(path, 0o755);
      return path;
    };
    return { dir, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("uses an explicit absolute override", () => {
    const f = fixture();
    try {
      const exe = f.make(join(f.dir, "custom", "pi"));
      assert.equal(launch.resolvePiExecutable({ PI_SUBAGENT_PI_EXECUTABLE: exe, PATH: "" }), exe);
    } finally { f.cleanup(); }
  });

  it("uses the managed launcher when pi is not on the parent PATH", () => {
    const f = fixture();
    try {
      const exe = f.make(join(f.dir, "agent", "bin", "pi"));
      const root = join(f.dir, "agent", "bin", "..", "install");
      assert.equal(launch.resolvePiExecutable({ PI_MANAGED_INSTALL_ROOT: root, PATH: "/usr/bin:/bin" }), exe);
    } finally { f.cleanup(); }
  });

  it("resolves pi from PATH to an absolute path", () => {
    const f = fixture();
    try {
      const exe = f.make(join(f.dir, "bin", "pi"));
      assert.equal(launch.resolvePiExecutable({ PATH: `/nonexistent:${join(f.dir, "bin")}` }), exe);
    } finally { f.cleanup(); }
  });

  it("prefers pi on PATH over the managed launcher", () => {
    const f = fixture();
    try {
      f.make(join(f.dir, "agent", "bin", "pi"));
      const onPath = f.make(join(f.dir, "path", "pi"));
      const env = { PI_MANAGED_INSTALL_ROOT: join(f.dir, "agent", "install"), PATH: join(f.dir, "path") };
      assert.equal(launch.resolvePiExecutable(env), onPath);
    } finally { f.cleanup(); }
  });

  it("falls back to bare pi", () => {
    assert.equal(launch.resolvePiExecutable({ PATH: "/nonexistent" }), "pi");
  });
});
