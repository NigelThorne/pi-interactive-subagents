import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [hostRoot, extensionPath, root] = process.argv.slice(2);
const host = await import(pathToFileURL(join(hostRoot, "dist/index.js")));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = host;
const agentDir = join(root, "config");
mkdirSync(join(root, ".pi/agent/agents"), { recursive: true });
mkdirSync(join(root, "bin"), { recursive: true });
writeFileSync(join(root, ".pi/agent/agents/wired.md"), "---\nname: wired\ndescription: UI wiring\nmodel: balanced\n---\nrole\n");
writeFileSync(join(root, "bin/pi"), "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"stopReason\":\"stop\"}}'\n");
chmodSync(join(root, "bin/pi"), 0o755);
process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
const settings = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
  additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const credentials = { async read(){return undefined;}, async list(){return [];}, async modify(_p, fn){return fn(undefined);}, async delete(){} };
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const sessionManager = SessionManager.inMemory(root);
const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager, modelRuntime, tools: ["subagent_sync"] });
await session.bindExtensions({});
try {
  const tool = session.extensionRunner.getToolDefinition("subagent_sync");
  const models = [{ provider: "test", id: "local" }];
  const registry = { getAll: () => models, getAvailable: () => models, find: (provider, id) => models.find(model => model.provider === provider && model.id === id), hasConfiguredAuth: () => true };
  let selects = 0;
  const ctx = { cwd: root, hasUI: true, modelRegistry: registry, ui: { confirm: async () => true, select: async (_title, options) => { selects++; return selects === 1 ? "test/local" : "low"; } } };
  const params = { agent: "wired", task: "offline", agentScope: "user" };
  const first = await tool.execute("one", params, new AbortController().signal, undefined, ctx);
  assert.equal(first.details.results[0].exitCode, 0);
  const second = await tool.execute("two", params, new AbortController().signal, undefined, { ...ctx, ui: { ...ctx.ui, select: async () => assert.fail("saved choice must avoid another prompt") } });
  assert.equal(second.details.results[0].exitCode, 0);
  assert.equal(selects, 2);
  const profile = JSON.parse(readFileSync(join(root, ".pi/agent/model-categories.json"), "utf8"));
  assert.deepEqual(profile.categories.balanced, { provider: "test", model: "local", thinking: "low" });
} finally { session.dispose(); }
