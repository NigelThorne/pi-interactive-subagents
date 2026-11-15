import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, hostRoot, extensionPath, providerPath, root, sessionPath, targetPath] = process.argv.slice(2);

async function openSession(path, subagentName) {
  const host = await import(pathToFileURL(join(hostRoot, "dist/index.js")));
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = host;
  const agentDir = join(root, "config"); mkdirSync(agentDir, { recursive: true });
  if (subagentName) process.env.PI_SUBAGENT_NAME = subagentName; else delete process.env.PI_SUBAGENT_NAME;
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
    additionalExtensionPaths: [extensionPath, providerPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const credentials = { async read(){return undefined;}, async list(){return [];}, async modify(_p, fn){return fn(undefined);}, async delete(){} };
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const manager = SessionManager.open(path);
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: manager, modelRuntime, model: { provider: "lifecycle-test", id: "synthetic" }, tools: ["subagent_steer", "subagent_status"] });
  await session.bindExtensions({});
  await session.extensionRunner.emit({ type: "session_start" });
  return { session, manager };
}

if (mode === "receiver") {
  const opened = await openSession(sessionPath);
  writeFileSync(join(root, "receiver.ready"), "ready");
  try {
    while (!existsSync(join(root, "receiver.stop"))) await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    await opened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    opened.session.dispose();
  }
} else if (mode === "sender") {
  const nested = process.env.TEST_NESTED === "1";
  const opened = await openSession(sessionPath, nested ? "Nested caller" : undefined);
  try {
    const tool = opened.session.extensionRunner.getToolDefinition("subagent_steer");
    assert.ok(tool, "registered steering tool is available");
    const result = await tool.execute("steer", { target: targetPath, message: nested ? "nested wiring message" : "parent wiring message" });
    assert.equal(result.details.status, "accepted", JSON.stringify(result));
    const status = opened.session.extensionRunner.getToolDefinition("subagent_status");
    const discovered = await status.execute("all", { scope: "all" });
    assert.ok(discovered.details.sessions.some(route => route.session.path === targetPath));
  } finally {
    await opened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    opened.session.dispose();
  }
} else {
  const parentPath = join(root, "parent.jsonl"), childPath = join(root, "child.jsonl"), nestedPath = join(root, "nested.jsonl");
  const header = (id, parentSession) => ({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root, ...(parentSession ? { parentSession } : {}) });
  writeFileSync(parentPath, JSON.stringify(header("parent")) + "\n");
  writeFileSync(childPath, JSON.stringify(header("child", parentPath)) + "\n");
  writeFileSync(nestedPath, JSON.stringify(header("nested")) + "\n");
  const child = spawn(process.execPath, [import.meta.filename, "receiver", hostRoot, extensionPath, providerPath, root, childPath], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => stderr += chunk);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, "receiver.ready")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(join(root, "receiver.ready")), `receiver did not start: ${stderr}`);
    execFileSync(process.execPath, [import.meta.filename, "sender", hostRoot, extensionPath, providerPath, root, parentPath, childPath], { env: process.env, stdio: "pipe" });
    execFileSync(process.execPath, [import.meta.filename, "sender", hostRoot, extensionPath, providerPath, root, nestedPath, childPath], { env: { ...process.env, TEST_NESTED: "1" }, stdio: "pipe" });
    const messageDeadline = Date.now() + 3000; let text = "";
    while (Date.now() < messageDeadline) { text = readFileSync(childPath, "utf8"); if (text.includes("nested wiring message")) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.match(text, /parent wiring message/); assert.match(text, /Sender relationship: parent/);
    assert.match(text, /nested wiring message/); assert.match(text, /Sender relationship: other/);
  } finally {
    writeFileSync(join(root, "receiver.stop"), "stop");
    await new Promise(resolve => child.once("exit", resolve));
    assert.equal(child.exitCode, 0, stderr);
  }
}
