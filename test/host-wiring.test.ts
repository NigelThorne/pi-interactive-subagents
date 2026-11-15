import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const repo = resolve(import.meta.dirname, "../../..");
const interactive = join(repo, "extensions/pi-interactive-subagents/pi-extension/subagents/index.ts");
const synchronous = join(repo, "extensions/subagent/index.ts");
const provider = join(repo, "extensions/pi-interactive-subagents/test/fixtures/lifecycle-provider.ts");
const piExecutable = execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8" }).trim();
const hostRoot = process.env.PI_PACKAGE_ROOT ?? join(homedir(), ".pi/agent/install/releases", readFileSync(join(homedir(), ".pi/agent/install/current-version"), "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");

function fixture(root: string) {
  const config = join(root, "config");
  const agents = join(root, ".pi/agent/agents");
  const bin = join(root, "bin");
  mkdirSync(config, { recursive: true }); mkdirSync(agents, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(agents, "wired.md"), "---\nname: wired\ndescription: Wired test\nmodel: balanced\nthinking: low\n---\nNever runs\n");
  const marker = join(root, "spawned");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\necho spawned > ${JSON.stringify(marker)}\nexit 99\n`); chmodSync(join(bin, "pi"), 0o755);
  return { config, marker, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0", PATH: `${bin}:${process.env.PATH}` } };
}

async function runPi(root: string, extension: string, scenario: string, tools: string, extraEnv: Record<string, string> = {}, configure?: (fx: ReturnType<typeof fixture>) => void) {
  const fx = fixture(root);
  configure?.(fx);
  const session = join(root, "parent.jsonl");
  const args = ["--mode", "json", "-p", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
    "--session", session, "-e", extension, "-e", provider, "--model", "lifecycle-test/synthetic", "--thinking", "off", "--tools", tools, "exercise registered tool"];
  const child = spawn(piExecutable, args, { cwd: root, env: { ...fx.env, ...extraEnv, TEST_SCENARIO: scenario }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  const code = await new Promise<number | null>((resolveExit, reject) => { child.on("error", reject); child.on("exit", resolveExit); });
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /Failed to load|Error loading|extension_error/);
  return { fx, stdout, session };
}

it("real registered synchronous tool prompts, saves, and reuses the choice on its next launch", { timeout: 20_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "profile-ui-host-"));
  try {
    execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/ui-wiring-runner.mjs"), hostRoot, synchronous, root], {
      cwd: repo, env: { ...process.env, HOME: root }, encoding: "utf8", timeout: 15_000,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("real registered synchronous tool returns structured headless choice and never spawns", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "profile-sync-host-"));
  try {
    const { fx, stdout, session } = await runPi(root, synchronous, "call-sync", "subagent_sync");
    assert.match(stdout, /Choose a local model for the 'balanced' category/);
    assert.equal(existsSync(fx.marker), false);
    const entries = readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
    const result = entries.find((entry: any) => entry.type === "message" && entry.message?.role === "toolResult");
    assert.equal(result?.message?.details?.results?.[0]?.errorKind, "needs_model_choice");
    assert.equal(result?.message?.details?.results?.[0]?.category, "balanced");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("real parallel tool discovers the project definition for each task cwd", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "profile-taskcwd-host-"));
  const taskCwd = join(root, "other-project", "nested");
  try {
    mkdirSync(join(root, "other-project", ".pi/agents"), { recursive: true });
    mkdirSync(taskCwd, { recursive: true });
    writeFileSync(join(root, "other-project", ".pi/agents/wired.md"), "---\nname: wired\ndescription: Project wired\nmodel: deep\nthinking: low\n---\nProject role\n");
    const { fx, session } = await runPi(root, synchronous, "call-sync-project", "subagent_sync", { TEST_TASK_CWD: taskCwd });
    assert.equal(existsSync(fx.marker), false);
    const entries = readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
    const result = entries.find((entry: any) => entry.type === "message" && entry.message?.role === "toolResult");
    assert.equal(result?.message?.details?.results?.[0]?.agentSource, "project");
    assert.equal(result?.message?.details?.results?.[0]?.category, "deep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("real synchronous runtime rejection records a replacement request and never replays", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "profile-runtime-host-"));
  try {
    const { fx, session } = await runPi(root, synchronous, "call-sync", "subagent_sync", {}, () => {
      mkdirSync(join(root, ".pi/agent"), { recursive: true });
      writeFileSync(join(root, ".pi/agent/model-categories.json"), JSON.stringify({ version: 1, categories: { balanced: { provider: "lifecycle-test", model: "synthetic", thinking: "low" } } }));
      writeFileSync(join(root, "bin/pi"), `#!/bin/sh\necho x >> ${JSON.stringify(join(root, "spawned"))}\nprintf '%s\\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "lifecycle-test", model: "synthetic", content: [], stopReason: "error", errorMessage: "unsupported_model: synthetic is unavailable" } })}'\nexit 1\n`);
      chmodSync(join(root, "bin/pi"), 0o755);
    });
    assert.equal(readFileSync(fx.marker, "utf8").trim(), "x", "one launch and no replay");
    const entries = readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
    const result = entries.find((entry: any) => entry.type === "message" && entry.message?.role === "toolResult");
    assert.equal(result?.message?.details?.results?.[0]?.errorKind, "unsupported_model");
    assert.equal(result?.message?.details?.results?.[0]?.replacement?.kind, "needs_model_choice");
    assert.match(result?.message?.content?.[0]?.text ?? "", /ask Nigel/i);
    assert.match(result?.message?.content?.[0]?.text ?? "", /unsupported_model: synthetic is unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("real async runtime rejection stops a settled child, saves the next-launch choice, and reports it", { timeout: 20_000 }, (t) => {
  let tmux: string;
  try { tmux = execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim(); } catch { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "profile-async-runtime-"));
  const socket = join(root, "tmux.sock");
  try {
    execFileSync(tmux, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "host", "-c", root]);
    const pane = execFileSync(tmux, ["-S", socket, "display-message", "-p", "#{pane_id}"], { encoding: "utf8" }).trim();
    execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/async-runtime-wiring-runner.mjs"), hostRoot, interactive, root], {
      cwd: repo,
      env: { ...process.env, HOME: root, TMUX: `${socket},99999,0`, TMUX_PANE: pane, PI_SUBAGENT_MUX: "tmux", PI_SUBAGENT_TMUX_EXECUTABLE: tmux },
      encoding: "utf8", timeout: 15_000,
    });
  } finally {
    try { execFileSync(tmux!, ["-S", socket, "kill-server"]); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

it("real Pi sessions steer across parent and nested callers without terminal delivery", { timeout: 20_000 }, () => {
  // macOS AF_UNIX socket paths are limited to 104 bytes; HOME under the
  // default $TMPDIR (/var/folders/...) makes the messaging socket path too long.
  const root = mkdtempSync("/tmp/steering-host-");
  try {
    execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/steering-wiring-runner.mjs"), "orchestrate", hostRoot, interactive, provider, root], {
      cwd: repo,
      env: { ...process.env, HOME: root, PI_OFFLINE: "1", PI_TELEMETRY: "0", TEST_SCENARIO: "steering" },
      encoding: "utf8",
      timeout: 15_000,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("real registered async tool uses shared headless preflight and creates no child pane", { timeout: 20_000 }, async (t) => {
  let tmux: string;
  try { tmux = execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim(); } catch { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "profile-async-host-"));
  const socket = join(root, "tmux.sock");
  try {
    execFileSync(tmux, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "host", "-c", root]);
    const pane = execFileSync(tmux, ["-S", socket, "display-message", "-p", "#{pane_id}"], { encoding: "utf8" }).trim();
    const before = execFileSync(tmux, ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" }).trim().split("\n").length;
    const { fx, stdout, session } = await runPi(root, interactive, "call-async", "subagent", {
      TMUX: `${socket},99999,0`, TMUX_PANE: pane, PI_SUBAGENT_MUX: "tmux", PI_SUBAGENT_TMUX_EXECUTABLE: tmux,
    });
    assert.match(stdout, /Choose a local model for the 'balanced' category/);
    assert.equal(existsSync(fx.marker), false);
    const after = execFileSync(tmux, ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" }).trim().split("\n").length;
    assert.equal(after, before);
    const entries = readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
    const result = entries.find((entry: any) => entry.type === "message" && entry.message?.role === "toolResult");
    assert.equal(result?.message?.details?.kind, "needs_model_choice");
    assert.equal(result?.message?.details?.category, "balanced");
  } finally {
    try { execFileSync(tmux!, ["-S", socket, "kill-server"]); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
