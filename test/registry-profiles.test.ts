import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgents, findAgent } from "../pi-extension/subagents/agent-registry.ts";
import {
  prepareModelChoice,
  prepareRuntimeModelReplacement,
  resolveModelChoice,
  saveCategoryChoice,
  isAuthoritativeUnsupportedModelError,
} from "../pi-extension/subagents/model-categories.ts";
import {
  findRuntimeModelRejection,
  formatRuntimeModelRejection,
  startupUnsupportedFailure,
} from "../pi-extension/subagents/runtime-model-errors.ts";

function agent(dir: string, file: string, name: string, description = "") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\nname: ${name}\ndescription: ${description}\nmodel: balanced\n---\nRole ${name}\n`);
}

describe("shared agent registry", () => {
  it("uses frontmatter names, nearest project root, deterministic priority and scope", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-registry-"));
    try {
      const home = join(root, "home"), pkg = join(root, "pkg"), project = join(root, "repo"), cwd = join(project, "a", "b");
      mkdirSync(cwd, { recursive: true });
      agent(pkg, "bundled.md", "same", "package");
      agent(join(home, ".pi/agent/agents"), "legacy.md", "same", "legacy");
      agent(join(home, ".my-pi/agents"), "not-the-name.md", "same", "my-pi");
      agent(join(project, ".pi/agents"), "odd-file.md", "same", "project");
      agent(join(project, ".pi/agents"), "missing-description.md", "launchable");
      const both = discoverAgents({ cwd, scope: "both", home, packageAgentsDir: pkg });
      assert.equal(findAgent(both, "same")?.description, "project");
      assert.equal(findAgent(both, "launchable")?.filePath.endsWith("missing-description.md"), true);
      assert.equal(discoverAgents({ cwd, scope: "user", home, packageAgentsDir: pkg }).agents[0].description, "my-pi");
      assert.equal(discoverAgents({ cwd, scope: "project", home, packageAgentsDir: pkg }).agents.length, 2);
      assert.equal(findAgent(both, "../same"), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("parses multiline YAML descriptions, comments, and quoted escapes without falling through priority", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-registry-yaml-"));
    try {
      const home = join(root, "home"), pkg = join(root, "pkg"), project = join(root, "repo");
      mkdirSync(join(project, "child"), { recursive: true });
      agent(pkg, "fallback.md", "yaml-agent", "fallback");
      const dir = join(project, ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "definition.md"), `---\n# valid YAML comment\nname: "yaml-agent"\ndescription: >-\n  First line with a colon:\n  second \\"quoted\\" line\nmodel: balanced\n---\nPinned body\n`);
      const found = findAgent(discoverAgents({ cwd: join(project, "child"), home, packageAgentsDir: pkg }), "yaml-agent");
      assert.equal(found?.source, "project");
      assert.match(found?.description ?? "", /First line with a colon: second/);
      assert.match(found?.fileHash ?? "", /^[a-f0-9]{64}$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("model categories", () => {
  const models = [{ provider: "p", id: "fast" }, { provider: "p", id: "deep" }];
  const registry = { getAll: () => models, getAvailable: () => models, find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), hasConfiguredAuth: () => true };
  it("resolves a configured category once and preserves concrete overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-"));
    try {
      const file = join(root, "model-categories.json");
      writeFileSync(file, JSON.stringify({ version: 1, categories: { balanced: { provider: "p", model: "fast", thinking: "medium" } } }));
      assert.deepEqual(resolveModelChoice("balanced", undefined, { registry, file }), { kind: "resolved", category: "balanced", provider: "p", model: "fast", thinking: "medium", configuredChoice: { provider: "p", model: "fast", thinking: "medium" } });
      assert.deepEqual(resolveModelChoice("p/deep", "high", { registry, file }), { kind: "resolved", model: "p/deep", thinking: "high" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("fails closed for missing, unavailable and corrupt profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-"));
    try {
      const file = join(root, "model-categories.json");
      assert.equal(resolveModelChoice("fast", undefined, { registry, file }).kind, "needs_model_choice");
      writeFileSync(file, "{");
      assert.throws(() => resolveModelChoice("fast", undefined, { registry, file }), /corrupt/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("atomically saves choices, preserves unrelated categories, and detects conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-"));
    try {
      const file = join(root, "model-categories.json");
      saveCategoryChoice("fast", { provider: "p", model: "fast" }, { file, expected: undefined });
      const expected = { provider: "p", model: "fast" };
      saveCategoryChoice("deep", { provider: "p", model: "deep", thinking: "high" }, { file, expected: undefined });
      assert.throws(() => saveCategoryChoice("fast", { provider: "p", model: "deep" }, { file, expected: { provider: "other", model: "x" } }), /conflict/i);
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(parsed.categories.fast, expected);
      assert.equal(parsed.categories.deep.thinking, "high");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("prompts, validates thinking, saves, and uses the choice on the next launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-ui-"));
    try {
      const file = join(root, "model-categories.json");
      const calls: string[][] = [];
      const ui = { select: async (_title: string, options: string[]) => { calls.push(options); return calls.length === 1 ? "p/fast" : "low"; } };
      const first = await prepareModelChoice("balanced", undefined, { registry, file, hasUI: true, ui });
      assert.deepEqual(first, { kind: "resolved", category: "balanced", provider: "p", model: "fast", thinking: "low", configuredChoice: { provider: "p", model: "fast", thinking: "low" } });
      const second = await prepareModelChoice("balanced", undefined, { registry, file, hasUI: true, ui });
      assert.equal(second.kind, "resolved");
      assert.equal(calls.length, 2, "next launch does not prompt");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("cancels and pre-aborts without saving, and returns structured headless/auth outcomes", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-cancel-"));
    try {
      const file = join(root, "model-categories.json");
      let prompts = 0;
      const cancelled = await prepareModelChoice("fast", undefined, { registry, file, hasUI: true, ui: { select: async () => { prompts++; return undefined; } } });
      assert.equal(cancelled.kind, "cancelled");
      assert.equal(resolveModelChoice("fast", undefined, { registry, file }).kind, "needs_model_choice");
      const controller = new AbortController(); controller.abort();
      assert.equal((await prepareModelChoice("deep", undefined, { registry, file, hasUI: true, signal: controller.signal, ui: { select: async () => { prompts++; return "p/deep"; } } })).kind, "cancelled");
      const headless = await prepareModelChoice("deep", undefined, { registry, file, hasUI: false });
      assert.deepEqual({ kind: headless.kind, category: "category" in headless ? headless.category : undefined }, { kind: "needs_model_choice", category: "deep" });
      writeFileSync(file, JSON.stringify({ version: 1, categories: { fast: { provider: "p", model: "fast" } } }));
      const unauthRegistry = { ...registry, getAvailable: () => [], hasConfiguredAuth: () => false };
      const auth = await prepareModelChoice("fast", undefined, { registry: unauthRegistry, file, hasUI: true, ui: { select: async () => { prompts++; return "p/deep"; } } });
      assert.equal(auth.kind, "auth_error");
      assert.equal(prompts, 1, "missing authentication never opens replacement selector");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("serializes simultaneous choices, recovers after selector rejection, and avoids double prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-queue-"));
    try {
      const file = join(root, "model-categories.json");
      let calls = 0;
      const failing = prepareModelChoice("balanced", "low", { registry, file, hasUI: true, ui: { select: async () => { calls++; throw new Error("UI failed"); } } });
      await assert.rejects(failing, /UI failed/);
      const ui = { select: async () => { calls++; return "p/fast"; } };
      const [a, b] = await Promise.all([
        prepareModelChoice("balanced", "low", { registry, file, hasUI: true, ui }),
        prepareModelChoice("balanced", "low", { registry, file, hasUI: true, ui }),
      ]);
      assert.equal(a.kind, "resolved"); assert.equal(b.kind, "resolved"); assert.equal(calls, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("aborts a selector that ignores cancellation, releases the queue, and forwards signals to every selector", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-abort-"));
    try {
      const file = join(root, "model-categories.json");
      const controller = new AbortController();
      const seenSignals: Array<AbortSignal | undefined> = [];
      const hanging = prepareModelChoice("balanced", undefined, {
        registry, file, hasUI: true, signal: controller.signal,
        ui: { select: async (_title, _values, options) => { seenSignals.push(options?.signal); return new Promise<string>(() => {}); } },
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      controller.abort();
      assert.equal((await hanging).kind, "cancelled");
      assert.equal(existsSync(file), false, "aborted prompt does not write config");
      const next = await prepareModelChoice("balanced", "low", {
        registry, file, hasUI: true,
        ui: { select: async (_title, _values, options) => { seenSignals.push(options?.signal); return "p/fast"; } },
      });
      assert.equal(next.kind, "resolved", "next queued prompt is not blocked by ignored cancellation");
      assert.equal(seenSignals[0], controller.signal);
      assert.equal(seenSignals.length, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("passes cancellation through model, thinking, and runtime replacement selectors", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-signals-"));
    try {
      const file = join(root, "model-categories.json");
      const controller = new AbortController();
      const signals: Array<AbortSignal | undefined> = [];
      const ui = { select: async (_title: string, _values: string[], options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        return signals.length === 1 ? "p/fast" : signals.length === 2 ? "low" : "p/deep";
      } };
      const first = await prepareModelChoice("balanced", undefined, { registry, file, hasUI: true, signal: controller.signal, ui });
      assert.equal(first.kind, "resolved");
      const expected = { provider: "p", model: "fast", thinking: "low" as const };
      const replacement = await prepareRuntimeModelReplacement("balanced", expected, "p/fast", { registry, file, hasUI: true, signal: controller.signal, ui });
      assert.equal(replacement.kind, "resolved");
      assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("saves runtime replacements for next launch without replay and reuses a newer mapping", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-runtime-"));
    try {
      const file = join(root, "model-categories.json");
      const old = { provider: "p", model: "fast", thinking: "high" as const };
      saveCategoryChoice("deep", old, { file });
      const replaced = await prepareRuntimeModelReplacement("deep", old, "p/fast", { registry, file, hasUI: true, ui: { select: async () => "p/deep" } });
      assert.equal(replaced.kind, "resolved");
      assert.equal(resolveModelChoice("deep", undefined, { registry, file }).model, "deep");
      const reused = await prepareRuntimeModelReplacement("deep", old, "p/fast", { registry, file, hasUI: true, ui: { select: async () => assert.fail("must not overwrite newer mapping") } });
      assert.equal(reused.kind, "resolved");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("only classifies authoritative unsupported-model provider errors", () => {
    assert.equal(isAuthoritativeUnsupportedModelError({ role: "assistant", stopReason: "error", errorMessage: "The 'x' model is not supported when using Codex with a ChatGPT account." }), true);
    assert.equal(isAuthoritativeUnsupportedModelError({ role: "assistant", stopReason: "error", errorMessage: "model_not_found" }), true);
    for (const errorMessage of [
      "rate limit exceeded: unsupported_model",
      "invalid_api_key: unsupported_model",
      "token expired while handling unsupported_model",
      "HTTP 401 unsupported_model", "HTTP 403 unsupported_model",
      "ECONNRESET while handling unsupported_model", "ENOTFOUND unsupported_model",
      "DNS failure: model_not_found", "transport timeout: unsupported_model",
    ]) assert.equal(isAuthoritativeUnsupportedModelError({ role: "assistant", stopReason: "error", errorMessage }), false, errorMessage);
    assert.equal(isAuthoritativeUnsupportedModelError({ role: "toolResult", stopReason: "error", errorMessage: "unsupported_model" }), false);
    assert.equal(isAuthoritativeUnsupportedModelError({ role: "assistant", stopReason: "error", errorMessage: "ordinary failure", content: [{ type: "text", text: "unsupported_model model_not_found" }] } as any), false);
    assert.equal(isAuthoritativeUnsupportedModelError({ stopReason: "stop", errorMessage: "model is not supported" }), false);
  });
});

describe("runtime model rejection", () => {
  const pinned = { provider: "openai-codex", model: "gpt-5.4", thinking: "high" as const };
  const error = (overrides: Record<string, unknown> = {}) => ({
    role: "assistant", provider: "openai-codex", model: "gpt-5.4", stopReason: "error",
    errorMessage: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.", content: [], ...overrides,
  });
  const entry = (message: any, id = Math.random().toString()) => ({ type: "message", id, message });
  const settled = { type: "custom", id: "settled", customType: "timeline-telemetry", data: { event: "agent_settled" } };

  it("binds rejection to the pinned provider/model, including qualified and missing reported IDs", () => {
    assert.equal(findRuntimeModelRejection([error()], pinned)?.model, "openai-codex/gpt-5.4");
    assert.equal(findRuntimeModelRejection([error({ model: "openai-codex/gpt-5.4" })], pinned)?.model, "openai-codex/gpt-5.4");
    assert.equal(findRuntimeModelRejection([error({ provider: "other" })], pinned), undefined);
    assert.equal(findRuntimeModelRejection([error({ model: "gpt-5.3" })], pinned), undefined);
    assert.equal(findRuntimeModelRejection([error({ provider: undefined, model: undefined })], pinned)?.model, "openai-codex/gpt-5.4", "explicit model in provider error is conservative evidence");
    assert.equal(findRuntimeModelRejection([error({ provider: undefined, model: undefined, errorMessage: "unsupported_model" })], pinned), undefined);
    assert.equal(findRuntimeModelRejection([error(), error({ provider: "other", model: "gpt-5.4" })], pinned), undefined, "a later model switch is authoritative");
  });

  it("requires settled no-work launch entries before stopping an interactive child", () => {
    assert.equal(startupUnsupportedFailure([entry(error()), settled], pinned)?.errorMessage.includes("not supported"), true);
    assert.equal(startupUnsupportedFailure([entry(error())], pinned), undefined, "error emission alone is not settled");
    assert.equal(startupUnsupportedFailure([entry(error()), entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "retry worked" }] }), settled], pinned), undefined);
    assert.equal(startupUnsupportedFailure([entry(error()), entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }), settled], pinned), undefined);
    assert.equal(startupUnsupportedFailure([entry(error()), entry({ role: "toolResult", content: [] }), settled], pinned), undefined);
    assert.equal(startupUnsupportedFailure([entry(error({ provider: "other" })), settled], pinned), undefined);
  });

  it("makes replacement action visible while preserving the original failure and no-replay policy", () => {
    const original = error().errorMessage;
    const headless = formatRuntimeModelRejection("deep", original, { kind: "needs_model_choice" });
    assert.match(headless, /ask Nigel/i); assert.match(headless, /deep/); assert.match(headless, /not supported/);
    const saved = formatRuntimeModelRejection("deep", original, { kind: "resolved", provider: "p", model: "deep" });
    assert.match(saved, /saved for the next launch/i); assert.match(saved, /task was not replayed/i); assert.match(saved, /not supported/);
    const cancelled = formatRuntimeModelRejection("deep", original, { kind: "cancelled" });
    assert.equal(cancelled, original);
  });
});
