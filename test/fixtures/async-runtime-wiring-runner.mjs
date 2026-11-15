import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [hostRoot, extensionPath, root] = process.argv.slice(2);
const host = await import(pathToFileURL(join(hostRoot, "dist/index.js")));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = host;
const agentDir = join(root, "config");
mkdirSync(join(root, ".pi/agent/agents"), { recursive: true });
mkdirSync(join(root, ".pi/agent"), { recursive: true });
mkdirSync(join(root, "bin"), { recursive: true });
writeFileSync(join(root, ".pi/agent/agents/wired.md"), "---\nname: wired\ndescription: Runtime wiring\nmodel: balanced\nthinking: low\n---\nrole\n");
writeFileSync(join(root, ".pi/agent/model-categories.json"), JSON.stringify({ version: 1, categories: { balanced: { provider: "test", model: "local", thinking: "low" } } }));
const childScript = `#!/usr/bin/env node
const fs = require("node:fs");
const i = process.argv.indexOf("--session");
const file = process.argv[i + 1];
const now = new Date().toISOString();
const message = { type: "message", id: "runtime-error", parentId: null, timestamp: now, message: { role: "assistant", provider: "test", model: "local", content: [], stopReason: "error", errorMessage: "unsupported_model: test/local is unavailable" } };
const settled = { type: "custom", id: "runtime-settled", parentId: "runtime-error", timestamp: now, customType: "timeline-telemetry", data: { event: "agent_settled" } };
fs.appendFileSync(file, JSON.stringify(message) + "\\n" + JSON.stringify(settled) + "\\n");
setInterval(() => {}, 1000);
`;
writeFileSync(join(root, "bin/pi"), childScript); chmodSync(join(root, "bin/pi"), 0o755);
process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
const settings = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
  additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const credentials = { async read(){return undefined;}, async list(){return [];}, async modify(_p, fn){return fn(undefined);}, async delete(){} };
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const sessionManager = SessionManager.create(root, join(root, "sessions"));
const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager, modelRuntime, tools: ["subagent"] });
await session.bindExtensions({});
let disposed = false;
try {
  const tool = session.extensionRunner.getToolDefinition("subagent");
  const models = [{ provider: "test", id: "local" }, { provider: "test", id: "next" }];
  const registry = { getAll: () => models, getAvailable: () => models, find: (provider, id) => models.find(model => model.provider === provider && model.id === id), hasConfiguredAuth: () => true };
  const controller = new AbortController();
  const ctx = { cwd: root, hasUI: true, modelRegistry: registry, sessionManager,
    ui: { select: async (_title, options, selectOptions) => { assert.equal(selectOptions?.signal?.aborted, false); return options.includes("test/next") ? "test/next" : options[0]; }, setWidget() {} } };
  const launched = await tool.execute("runtime", { agent: "wired", name: "Wired", task: "offline" }, controller.signal, undefined, ctx);
  assert.equal(launched.details.status, "started");
  const deadline = Date.now() + 7000;
  let result;
  while (Date.now() < deadline) {
    result = sessionManager.getBranch().find(entry => entry.type === "custom_message" && entry.customType === "subagent_result");
    if (result) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(result, "async runtime result was delivered");
  assert.match(result.content, /unsupported_model: test\/local is unavailable/);
  assert.match(result.content, /saved for the next launch/i);
  assert.match(result.content, /task was not replayed/i);
  const profileFile = join(root, ".pi/agent/model-categories.json");
  const profile = JSON.parse(readFileSync(profileFile, "utf8"));
  assert.equal(profile.categories.balanced.model, "next");

  // A replacement dialog can outlive removal from the running map. Session
  // shutdown must still abort it and suppress stale parent entries/messages.
  writeFileSync(profileFile, JSON.stringify({ version: 1, categories: { balanced: { provider: "test", model: "local", thinking: "low" } } }));
  const before = sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent_result").length;
  const hangingCtx = { ...ctx, ui: { ...ctx.ui, select: async (_title, _options, selectOptions) => {
    assert.equal(selectOptions?.signal?.aborted, false);
    return new Promise(() => {});
  } } };
  const second = await tool.execute("runtime-shutdown", { agent: "wired", name: "Wired shutdown", task: "offline" }, new AbortController().signal, undefined, hangingCtx);
  assert.equal(second.details.status, "started");
  await new Promise(resolve => setTimeout(resolve, 1600));
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose(); disposed = true;
  await new Promise(resolve => setTimeout(resolve, 100));
  const after = sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent_result").length;
  assert.equal(after, before, "shutdown suppresses stale async result delivery");
  assert.equal(JSON.parse(readFileSync(profileFile, "utf8")).categories.balanced.model, "local", "shutdown dialog does not save");
} finally { if (!disposed) session.dispose(); }
