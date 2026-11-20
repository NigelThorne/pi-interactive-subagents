import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  readCompletionSummary,
  hasCompletedAssistantTurn,
  hasCompletedAssistantTurnSince,
  precreateChildSessionFile,
  buildSubagentChildManifestData,
} from "../pi-extension/subagents/session.ts";
import {
  buildCompletionInstructions,
  buildParentCompletionHandoffInstructions,
  buildResumeFollowupMessage,
} from "../pi-extension/subagents/prompt.ts";

import {
  createSurface,
  shellEscape,
  isCmuxAvailable,
  prepareForSubagents,
  shouldRenameWorkspace,
} from "../pi-extension/subagents/cmux.ts";
import * as cmux from "../pi-extension/subagents/cmux.ts";
import { normalizePaneId, paneSurface } from "../pi-extension/subagents/zellij.ts";
import { steerRunningSubagent } from "../pi-extension/subagents/steering.ts";
import * as statusModule from "../pi-extension/subagents/status.ts";
import {
  formatSubagentStatus,
  inspectSubagentStatus,
  parseProcessRows,
} from "../pi-extension/subagents/status.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("/subagent_status command", () => {
  const source = readFileSync(new URL("../pi-extension/subagents/index.ts", import.meta.url), "utf8");

  function loadCommand(getSubagentStatusReport: () => { summary: string }) {
    // Exercise the actual registration without loading Pi's terminal dependencies.
    const start = source.indexOf('  pi.registerCommand("subagent_status",');
    assert.notEqual(start, -1, "registers /subagent_status");
    const end = source.indexOf("\n  // ── subagent_status tool", start);
    assert.notEqual(end, -1);
    const commands = new Map<string, any>();
    new Function("pi", "getSubagentStatusReport", source.slice(start, end))({
      registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
      sendUserMessage: () => assert.fail("must not trigger an AI turn"),
      sendMessage: () => assert.fail("must not inject a message"),
    }, getSubagentStatusReport);
    return commands.get("subagent_status");
  }

  it("shows the empty-parent report without an AI turn", async () => {
    const summary = "No subagents are tracked by this parent session.";
    const command = loadCommand(() => ({ summary }));
    const notices: unknown[] = [];
    await command.handler("", { ui: { notify: (...args: unknown[]) => notices.push(args) } });
    assert.deepEqual(notices, [[summary, "info"]]);
  });

  it("fetches a fresh report on each invocation and preserves multiline output", async () => {
    let calls = 0;
    const command = loadCommand(() => ({ summary: `Check ${++calls}\nWorker: running\nScout: unknown` }));
    const notices: string[] = [];
    const ctx = { ui: { notify: (text: string) => notices.push(text) } };
    await command.handler("", ctx);
    await command.handler("", ctx);
    assert.deepEqual(notices, [
      "Check 1\nWorker: running\nScout: unknown",
      "Check 2\nWorker: running\nScout: unknown",
    ]);
  });
});

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("hasCompletedAssistantTurn", () => {
    it("recognizes a completed text turn that auto-exit must close", () => {
      const completed = {
        ...ASSISTANT_MSG,
        message: { ...ASSISTANT_MSG.message, stopReason: "stop" },
      } as any;
      assert.equal(hasCompletedAssistantTurn([USER_MSG as any, completed]), true);
      assert.equal(hasCompletedAssistantTurn([USER_MSG as any, ASSISTANT_MSG as any]), false);
    });

    it("recognizes completion despite trailing telemetry", () => {
      const completed = {
        ...ASSISTANT_MSG,
        message: { ...ASSISTANT_MSG.message, stopReason: "stop" },
      } as any;
      const telemetry = { type: "custom", id: "telemetry", customType: "timeline-telemetry", data: { event: "agent_settled" } } as any;
      assert.equal(hasCompletedAssistantTurn([completed, telemetry]), true);
      assert.equal(hasCompletedAssistantTurn([completed, telemetry, USER_MSG as any]), false);
    });

    it("ignores a completed turn that predates a resumed session", () => {
      const completed = {
        ...ASSISTANT_MSG,
        message: { ...ASSISTANT_MSG.message, stopReason: "stop" },
      } as any;
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, completed]);
      const entryCountBeforeResume = getNewEntries(file, 0).length;

      assert.equal(hasCompletedAssistantTurn(getNewEntries(file, 0)), true);
      assert.equal(hasCompletedAssistantTurnSince(file, entryCountBeforeResume), false);
      assert.equal(findLastAssistantMessage(getNewEntries(file, entryCountBeforeResume)), null);
    });

    it("detects the completed turn and summary written after resume", () => {
      const historical = {
        ...ASSISTANT_MSG,
        message: { ...ASSISTANT_MSG.message, stopReason: "stop" },
      } as any;
      const resumed = {
        ...ASSISTANT_MSG_2,
        message: { ...ASSISTANT_MSG_2.message, stopReason: "stop" },
      } as any;
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, historical]);
      const entryCountBeforeResume = getNewEntries(file, 0).length;
      writeFileSync(file, JSON.stringify(resumed) + "\n", { flag: "a" });

      assert.equal(hasCompletedAssistantTurnSince(file, entryCountBeforeResume), true);
      assert.equal(
        findLastAssistantMessage(getNewEntries(file, entryCountBeforeResume)),
        "Updated plan with details.",
      );
    });
  });

  describe("readCompletionSummary", () => {
    it("uses the explicit completion sidecar instead of a trailing Done response", () => {
      const doneFile = join(dir, "agent.done");
      writeFileSync(`${doneFile}.summary`, "Critical finding: data loss remains.", "utf8");
      assert.equal(readCompletionSummary(doneFile), "Critical finding: data loss remains.");
    });

    it("returns null when no explicit completion summary exists", () => {
      assert.equal(readCompletionSummary(join(dir, "missing.done")), null);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("precreateChildSessionFile", () => {
    it("writes a header with parent session and effective cwd", () => {
      const file = join(dir, "child-session.jsonl");
      const timestamp = "2026-08-25T01:02:03.456Z";

      precreateChildSessionFile(file, {
        sessionId: "child-session-123",
        timestamp,
        cwd: "/tmp/child-cwd",
        parentSession: "/tmp/parent-session.jsonl",
      });

      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.deepEqual(header, {
        type: "session",
        version: 3,
        id: "child-session-123",
        timestamp,
        cwd: "/tmp/child-cwd",
        parentSession: "/tmp/parent-session.jsonl",
      });
    });

    it("uses exclusive write mode and never overwrites an existing file", () => {
      const file = join(dir, "existing-child-session.jsonl");
      writeFileSync(file, "original\n", "utf8");

      assert.throws(
        () =>
          precreateChildSessionFile(file, {
            sessionId: "child-session-456",
            timestamp: "2026-08-25T01:02:03.456Z",
            cwd: "/tmp/other-cwd",
            parentSession: "/tmp/other-parent.jsonl",
          }),
        (error: any) => error?.code === "EEXIST",
      );
      assert.equal(readFileSync(file, "utf8"), "original\n");
    });
  });

  describe("buildSubagentChildManifestData", () => {
    it("returns durable lineage data for the parent session entry", () => {
      assert.deepEqual(
        buildSubagentChildManifestData({
          id: "subagent-1",
          name: "Worker",
          agent: "worker",
          startTimestamp: "2026-08-25T01:02:03.456Z",
          childSessionPath: "/tmp/child.jsonl",
          parentSessionPath: "/tmp/parent.jsonl",
        }),
        {
          id: "subagent-1",
          name: "Worker",
          agent: "worker",
          startTimestamp: "2026-08-25T01:02:03.456Z",
          childSessionPath: "/tmp/child.jsonl",
          parentSessionPath: "/tmp/parent.jsonl",
          status: "started",
        },
      );
    });
  });
});

describe("prompt.ts", () => {
  describe("buildCompletionInstructions", () => {
    it("requires the real subagent_done tool name and avoids final-answer wording", () => {
      const prompt = buildCompletionInstructions();
      assert.match(prompt, /call the `subagent_done` tool/);
      assert.match(prompt, /Do not end the turn after only writing the summary/);
      assert.doesNotMatch(prompt, /subagent-done/);
      assert.doesNotMatch(prompt, /FINAL assistant message/);
    });

    it("requires explicit subagent_done even for auto-exit agents", () => {
      const prompt = buildCompletionInstructions({ autoExit: true });
      assert.match(prompt, /concise summary/);
      assert.match(prompt, /call the `subagent_done` tool/);
      assert.match(prompt, /Do not end the turn after only writing the summary/);
    });
  });

  describe("buildParentCompletionHandoffInstructions", () => {
    it("keeps the parent available instead of manually polling subagents", () => {
      const prompt = buildParentCompletionHandoffInstructions();

      assert.match(prompt, /automatically as a steer message/);
      assert.match(prompt, /Call `subagent_status` before claiming that the child Pi process is live/);
      assert.match(prompt, /Do not block the parent session/);
      assert.match(prompt, /Do not run `sleep`/);
      assert.match(prompt, /logs, worktrees, panes, or session files/);
      assert.match(prompt, /End the turn if no independent work remains/);
    });
  });

  describe("buildResumeFollowupMessage", () => {
    it("preserves the follow-up request and appends completion instructions", () => {
      const prompt = buildResumeFollowupMessage("Please make one more tweak.");
      assert.match(prompt, /^Please make one more tweak\./);
      assert.match(prompt, /call the `subagent_done` tool/);
      assert.match(prompt, /Do not wait for further input once finished\./);
    });

    it("separates instructions from the user message with a blank line", () => {
      const prompt = buildResumeFollowupMessage("Follow up");
      assert.match(prompt, /^Follow up\n\nWhen you complete this follow-up/);
    });
  });
});

describe("steering.ts", () => {
  it("sends a steer to the existing running pane without resuming a session", () => {
    const sent: Array<{ surface: string; message: string }> = [];
    const result = steerRunningSubagent({
      running: [{ id: "worker-1", name: "Worker", surface: "pane:12" }],
      target: "worker-1",
      message: "Stop the current approach and inspect the failing test.",
      send: (surface, message) => sent.push({ surface, message }),
    });

    assert.deepEqual(result, { agent: { id: "worker-1", name: "Worker", surface: "pane:12" } });
    assert.deepEqual(sent, [
      { surface: "pane:12", message: "Stop the current approach and inspect the failing test." },
    ]);
  });

  it("finds a running subagent by its Pi session ID after its display title changes", () => {
    const sent: Array<{ surface: string; message: string }> = [];
    const result = steerRunningSubagent({
      running: [{ id: "worker-1", name: "Worker", sessionId: "child-session-123", surface: "pane:12" }],
      target: "child-session-123",
      message: "Continue with the approved plan.",
      send: (surface, message) => sent.push({ surface, message }),
    });

    assert.deepEqual(result, {
      agent: { id: "worker-1", name: "Worker", sessionId: "child-session-123", surface: "pane:12" },
    });
    assert.deepEqual(sent, [{ surface: "pane:12", message: "Continue with the approved plan." }]);
  });

  it("rejects a pane that does not have a verified running child Pi", () => {
    const result = steerRunningSubagent({
      running: [{ id: "worker-1", name: "Worker", surface: "%12" }],
      target: "worker-1",
      message: "Use the latest plan.",
      isRunning: () => false,
      send: () => assert.fail("must not send a steer to an unverified pane"),
    });

    assert.deepEqual(result, { error: 'Subagent "Worker" does not have a verified running Pi process.' });
  });

  it("rejects a completed subagent before its pane can return to a shell prompt", () => {
    const result = steerRunningSubagent({
      running: [{ id: "worker-1", name: "Worker", surface: "pane:12", doneFile: "/tmp/worker.done" }],
      target: "worker-1",
      message: "Use the latest plan.",
      isComplete: (agent) => agent.doneFile === "/tmp/worker.done",
      send: () => assert.fail("must not send a steer to a completed subagent"),
    });

    assert.deepEqual(result, { error: 'Subagent "Worker" has already completed.' });
  });

  it("rejects an ambiguous subagent name instead of steering the wrong pane", () => {
    const result = steerRunningSubagent({
      running: [
        { id: "worker-1", name: "Worker", surface: "pane:12" },
        { id: "worker-2", name: "Worker", surface: "pane:13" },
      ],
      target: "Worker",
      message: "Use the latest plan.",
      send: () => assert.fail("must not send a steer for an ambiguous target"),
    });

    assert.deepEqual(result, { error: 'Multiple running subagents are named "Worker". Use an id: worker-1, worker-2.' });
  });
});

describe("status.ts", () => {
  it("reads optional presence snapshots without failing on missing or malformed files", () => {
    const dir = createTestDir();
    try {
      const sessionId = "session/encoded";
      const file = join(dir, `${encodeURIComponent(sessionId)}.json`);
      const readPresence = statusModule.readSubagentPresence;
      assert.equal(typeof readPresence, "function");
      assert.equal(readPresence(undefined, dir), undefined);
      assert.equal(readPresence(sessionId, dir), undefined);
      writeFileSync(file, '{"state":');
      assert.equal(readPresence(sessionId, dir), undefined);
      const record = { state: "idle", pid: 123, updatedAt: 9_000 };
      writeFileSync(file, JSON.stringify(record));
      assert.deepEqual(readPresence(sessionId, dir), record);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers psc-presence records, normalising them, and falls back to the legacy path", () => {
    const legacy = createTestDir();
    const psc = createTestDir();
    try {
      const read = statusModule.readSubagentPresence;
      const sessionId = "s-1";
      const base = { sessionId, sessionFile: "/tmp/w.jsonl", pid: 42, updatedAt: 9_000 };
      writeFileSync(join(legacy, `${sessionId}.json`), JSON.stringify({ sessionID: sessionId, state: "idle", pid: 1 }));
      assert.equal((read(sessionId, legacy, psc) as any).pid, 1);
      writeFileSync(join(psc, `${sessionId}.json`), JSON.stringify({ ...base, activity: "working" }));
      assert.deepEqual(read(sessionId, legacy, psc), { sessionID: sessionId, sessionFile: "/tmp/w.jsonl", pid: 42, updatedAt: 9_000, state: "processing" });
      writeFileSync(join(psc, `${sessionId}.json`), JSON.stringify({ ...base, activity: "idle" }));
      assert.equal((read(sessionId, legacy, psc) as any).state, "idle");
      writeFileSync(join(psc, `${sessionId}.json`), JSON.stringify(base));
      assert.equal((read(sessionId, legacy, psc) as any).state, undefined);
      assert.equal(statusModule.defaultPscPresenceDir({ XDG_STATE_HOME: "/x" }), "/x/psc/presence");
      assert.equal(statusModule.defaultPscPresenceDir({ HOME: "/h" }), "/h/.local/state/psc/presence");
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(psc, { recursive: true, force: true });
    }
  });

  it("maps psc records through inspectSubagentStatus with full validation", () => {
    const psc = createTestDir();
    const legacy = createTestDir();
    try {
      const a = { id: "w", name: "W", surface: "p", startTime: 1_000, sessionId: "s-2", sessionFile: "/tmp/w.jsonl", doneFile: "/tmp/w.done" };
      const probe = (presence: unknown) => ({ doneFileExists: false, paneState: "present" as const, processes: [{ pid: 42, ppid: 1, tty: "ttys1", state: "S", elapsed: "1", command: "pi" }], now: 10_000, presence });
      const write = (r: object) => { writeFileSync(join(psc, "s-2.json"), JSON.stringify({ sessionId: "s-2", sessionFile: "/tmp/w.jsonl", pid: 42, updatedAt: 9_000, ...r })); return statusModule.readSubagentPresence("s-2", legacy, psc); };
      assert.equal(inspectSubagentStatus(a, probe(write({ activity: "working" }))).activity, "processing");
      assert.equal(inspectSubagentStatus(a, probe(write({ activity: "idle" }))).activity, "idle");
      assert.equal(inspectSubagentStatus(a, probe(write({}))).activity, "unknown");
      assert.equal(inspectSubagentStatus(a, probe(write({ activity: "working", pid: 7 }))).activity, "unknown");
      assert.equal(inspectSubagentStatus(a, probe(write({ activity: "working", sessionFile: "/other" }))).activity, "unknown");
    } finally {
      rmSync(psc, { recursive: true, force: true });
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  const agent = {
    id: "worker-1",
    name: "Worker",
    surface: "pane:12",
    startTime: 1_000,
    sessionFile: "/tmp/worker-session.jsonl",
    doneFile: "/tmp/worker.done",
  };

  it("omits the steering target until the child Pi process is running", () => {
    const status = inspectSubagentStatus(
      { ...agent, id: "launch-7f3a", name: "Dashboard CLI help [worker]" },
      {
        doneFileExists: false,
        paneState: "present",
        processes: [],
        now: 11_000,
      },
    );
    assert.equal(
      formatSubagentStatus(status),
      'name="Dashboard CLI help [worker]"; lifecycle=unconfirmed; activity=unknown; pane=present; doneFile=absent; childPi=not found',
    );
  });

  it("reports running only when the child Pi process is present", () => {
    const processes = parseProcessRows(
      [
        "  122  100 ttys001 Ss+ 00:10 /bin/zsh -lc pi --session /tmp/worker-session.jsonl",
        "  123  122 ttys001 S+ 00:10 pi",
      ].join("\n"),
      agent.sessionFile,
    );

    const result = inspectSubagentStatus(agent, {
      doneFileExists: false,
      paneState: "present",
      processes,
      now: 11_000,
    });

    assert.equal(result.lifecycle, "running");
    assert.equal(result.paneState, "present");
    assert.deepEqual(result.processes.map((process) => process.pid), [123]);
    assert.equal(result.elapsedSeconds, 10);
  });

  describe("agent activity", () => {
    const tracked = { ...agent, sessionId: "session-1" };
    const processes = parseProcessRows("123 100 ttys001 S+ 00:10 pi --session /tmp/worker-session.jsonl", agent.sessionFile);
    const presence = {
      sessionID: tracked.sessionId,
      sessionFile: tracked.sessionFile,
      pid: 123,
      state: "idle",
      updatedAt: 9_000,
    };
    const probe = { doneFileExists: false, paneState: "present" as const, processes, now: 11_000 };

    it("distinguishes a live idle agent from a working agent", () => {
      const idle = inspectSubagentStatus(tracked, { ...probe, presence });
      assert.equal(idle.lifecycle, "running");
      assert.equal(idle.activity, "idle");
      assert.equal(idle.activityUpdatedAt, 9_000);
      assert.equal(idle.activityAgeSeconds, 2);
      assert.match(formatSubagentStatus(idle), /lifecycle=running; activity=idle; activityObservedAgo=2s/);
      assert.match(formatSubagentStatus(idle), /steerTarget="worker-1"/);

      const busy = inspectSubagentStatus(tracked, { ...probe, presence: { ...presence, state: "processing" } });
      assert.equal(busy.activity, "processing");
    });

    for (const [label, invalid] of Object.entries({
      missing: undefined,
      malformed: "idle",
      null: null,
      "wrong session": { ...presence, sessionID: "other" },
      "wrong path": { ...presence, sessionFile: "/other.jsonl" },
      "wrong PID": { ...presence, pid: 456 },
      stopped: { ...presence, state: "stopped" },
      "unknown state": { ...presence, state: "busy" },
      "future timestamp": { ...presence, updatedAt: 12_000 },
      "missing timestamp": { ...presence, updatedAt: undefined },
      "invalid timestamp": { ...presence, updatedAt: "9000" },
      "before launch": { ...presence, updatedAt: 500 },
    })) {
      it(`reports unknown activity for ${label} presence`, () => {
        const result = inspectSubagentStatus(tracked, { ...probe, presence: invalid });
        assert.equal(result.lifecycle, "running");
        assert.equal(result.activity, "unknown");
        assert.equal(result.activityUpdatedAt, undefined);
      });
    }

    it("rejects presence older than three 15-second heartbeats", () => {
      assert.equal(inspectSubagentStatus(tracked, { ...probe, presence, now: 54_000 }).activity, "idle");
      const result = inspectSubagentStatus(tracked, { ...probe, presence, now: 54_001 });
      assert.equal(result.activity, "unknown");
      assert.match(formatSubagentStatus(result), /activity=unknown/);
    });

    it("does not use presence as proof of a live process or of completion", () => {
      const missing = inspectSubagentStatus(tracked, { ...probe, presence, processes: [] });
      assert.equal(missing.lifecycle, "unconfirmed");
      assert.equal(missing.activity, "unknown");
      const done = inspectSubagentStatus(tracked, { ...probe, presence, doneFileExists: true });
      assert.equal(done.lifecycle, "completed");
      assert.equal(done.activity, "unknown");
      const ambiguous = inspectSubagentStatus(tracked, { ...probe, presence, processes: [...processes, { ...processes[0], pid: 456 }] });
      assert.equal(ambiguous.activity, "unknown");
    });
  });

  it("does not call a pane with no child Pi process running", () => {
    const result = inspectSubagentStatus(agent, {
      doneFileExists: false,
      paneState: "present",
      processes: [],
      now: 11_000,
    });

    assert.equal(result.lifecycle, "unconfirmed");
    assert.equal(result.paneState, "present");
  });

  it("reports completed when the done file exists even if a stale process row remains", () => {
    const result = inspectSubagentStatus(agent, {
      doneFileExists: true,
      paneState: "present",
      processes: parseProcessRows(
        [
          "  122  100 ttys001 Ss+ 00:10 /bin/zsh -lc pi --session /tmp/worker-session.jsonl",
          "  123  122 ttys001 S+ 00:10 pi",
        ].join("\n"),
        agent.sessionFile,
      ),
      now: 11_000,
    });

    assert.equal(result.lifecycle, "completed");
  });
});

describe("zellij.ts", () => {
  describe("normalizePaneId", () => {
    it("normalizes pane: ids", () => {
      assert.equal(normalizePaneId("pane:12"), "12");
    });

    it("normalizes terminal_ ids", () => {
      assert.equal(normalizePaneId("terminal_9"), "9");
    });
  });

  describe("paneSurface", () => {
    it("wraps normalized ids in pane prefix", () => {
      assert.equal(paneSurface("terminal_9"), "pane:9");
    });
  });

});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("prepareForSubagents", () => {
    it("keeps a Zellij main pane in its current tab when unrelated panes are present", () => {
      const binDir = createTestDir();
      const zellijLog = join(binDir, "zellij.log");
      const zellijPath = join(binDir, "zellij");
      writeFileSync(
        zellijPath,
        `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(zellijLog)}
case "$2" in
  list-panes) printf '[{"id":1,"tab_id":2,"is_plugin":false},{"id":3,"tab_id":2,"is_plugin":false}]' ;;
  list-tabs) printf '[{"tab_id":2,"position":0,"name":"shared"}]' ;;
  new-pane) printf '4' ;;
esac
`,
      );
      chmodSync(zellijPath, 0o755);

      const original = {
        PATH: process.env.PATH,
        PI_SUBAGENT_MUX: process.env.PI_SUBAGENT_MUX,
        PI_ZELLIJ_BREAK_PLUGIN: process.env.PI_ZELLIJ_BREAK_PLUGIN,
        ZELLIJ: process.env.ZELLIJ,
        ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID,
      };
      process.env.PATH = `${binDir}:${original.PATH ?? ""}`;
      process.env.PI_SUBAGENT_MUX = "zellij";
      process.env.PI_ZELLIJ_BREAK_PLUGIN = join(binDir, "missing-break-plugin.wasm");
      process.env.ZELLIJ = "test";
      process.env.ZELLIJ_PANE_ID = "1";

      try {
        assert.doesNotThrow(() => prepareForSubagents("π worker"));
        assert.equal(createSurface("worker"), "pane:4");

        const actions = readFileSync(zellijLog, "utf8");
        assert.match(actions, /rename-tab --tab-id 2 π worker/);
        assert.match(actions, /new-pane --tab-id 2 --direction right --name worker/);
        assert.doesNotMatch(actions, /launch-plugin|go-to-tab-by-id/);
      } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(binDir, { recursive: true, force: true });
      }
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("shouldRenameWorkspace", () => {
    it("disables zellij session renames by default", () => {
      assert.equal(shouldRenameWorkspace("zellij"), false);
    });
  });

  describe("isTabTitleSupported", () => {
    it("enables the title tool in stable Zellij and tmux runtimes", () => {
      const isTabTitleSupported = (cmux as typeof cmux & {
        isTabTitleSupported?: (backend: "cmux" | "tmux" | "zellij" | null) => boolean;
      }).isTabTitleSupported;

      assert.equal(isTabTitleSupported?.("zellij"), true);
      assert.equal(isTabTitleSupported?.("cmux"), false);
      assert.equal(isTabTitleSupported?.("tmux"), true);
      assert.equal(isTabTitleSupported?.(null), false);
    });
  });
});
