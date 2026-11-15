import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completionTools } from "../pi-extension/subagents/launch.ts";
import { readCompletion } from "../pi-extension/subagents/lifecycle.ts";

const doneExtension = fileURLToPath(new URL("../pi-extension/subagents/subagent-done.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/lifecycle-provider.ts", import.meta.url));

async function runPi(dir: string, session: string, scenario: string, suffix: string) {
  const done = join(dir, suffix + ".done");
  const config = join(dir, "config");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const child = spawn("pi", ["--mode", "rpc", "--offline", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-themes", "--session", session,
    "-e", doneExtension, "-e", fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url)), "-e", provider, "--model", "lifecycle-test/synthetic", "--thinking", "off",
    "--tools", completionTools("read")!], {
    cwd: dir, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: dir, TERM: "dumb", PI_CODING_AGENT_DIR: config,
      PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_NAME: "test",
      PI_SUBAGENT_SUMMARY_FILE: `${done}.summary`, TEST_SCENARIO: scenario },
  });
  let output = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    child.stdin.write(JSON.stringify({ type: "prompt", message: "Complete synthetic task" }) + "\n");
    // Keep stdin open: EOF must not be the reason the child exits.
    const code = await exited;
    assert.equal(code, 0, `Pi did not auto-exit cleanly. stderr=${stderr}; output=${output.slice(-3000)}`);
    const events = output.split("\n").filter((line) => line.trim()).map(JSON.parse);
    assert.deepEqual(events.filter((event) => event.type === "extension_error"), []);
    assert.doesNotMatch(stderr, /Failed to load|Error loading|Error:/);
    const entries = readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(entries.some((entry) => entry.customType === "test-shutdown"), "graceful shutdown observed");
    const tools = entries.filter((entry) => entry.customType === "test-active-tools").at(-1)?.data.tools;
    assert.deepEqual([...tools].sort(), ["read", "subagent_done"]);
    return { completion: readCompletion(done), entries };
  } finally { clearTimeout(deadline); child.stdin.destroy(); if (child.exitCode === null) child.kill("SIGKILL"); }
}

it("real Pi exits fresh and resumed tasks without subagent_done", { timeout: 40000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-"));
  try {
    const session = join(dir, "session.jsonl");
    const first = await runPi(dir, session, "reply", "first");
    assert.deepEqual(first.completion, { status: "reported", summary: "Synthetic result 1" });
    const second = await runPi(dir, session, "queued", "resume");
    assert.deepEqual(second.completion, { status: "reported", summary: "Synthetic result 2" });
    assert.equal(second.entries.filter((entry) => entry.customType === "test-shutdown").length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const scenario of ["error", "blocked-tool", "done-no-summary"]) {
  it(`real Pi exits with an honest ${scenario} result`, { timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-"));
    try {
      const result = await runPi(dir, join(dir, "session.jsonl"), scenario, "result");
      assert.equal(result.completion?.status, scenario === "error" ? "failed" : scenario === "blocked-tool" ? "blocked" : "completed");
      assert.match(result.completion!.summary, /Synthetic/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
