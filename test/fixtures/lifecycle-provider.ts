// Synthetic, offline provider for real-Pi lifecycle tests. Never calls a network service.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let calls = 0;
  let queued = false;
  pi.on("before_agent_start", () => {
    pi.appendEntry("test-active-tools", { tools: pi.getActiveTools() });
  });
  pi.on("agent_end", () => {
    if (process.env.TEST_SCENARIO === "queued" && !queued) {
      queued = true;
      pi.sendUserMessage("Synthetic queued follow-up", { deliverAs: "followUp" });
    }
  });
  pi.on("agent_settled", () => pi.appendEntry("timeline-telemetry", { event: "agent_settled" }));
  pi.on("session_shutdown", () => pi.appendEntry("test-shutdown", { event: "shutdown" }));
  pi.registerProvider("lifecycle-test", {
    baseUrl: "http://invalid.invalid",
    apiKey: "synthetic-offline-test",
    api: "lifecycle-test-api",
    models: [{ id: "synthetic", name: "Synthetic", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model) {
      calls++;
      const scenario = process.env.TEST_SCENARIO;
      const stream = createAssistantMessageEventStream();
      const output: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: `Synthetic result ${calls}` }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (scenario === "error") {
        output.content = []; output.stopReason = "error"; output.errorMessage = "Synthetic permanent failure";
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        if ((scenario === "call-sync" || scenario === "call-sync-project" || scenario === "call-async") && calls === 1) {
          output.stopReason = "toolUse";
          output.content = [{ type: "toolCall", id: `wiring-${calls}`,
            name: scenario === "call-async" ? "subagent" : "subagent_sync",
            arguments: scenario === "call-async"
              ? { agent: "wired", name: "Wired", task: "must not spawn" }
              : scenario === "call-sync-project"
                ? { tasks: [{ agent: "wired", task: "must not spawn", cwd: process.env.TEST_TASK_CWD }], agentScope: "both", confirmProjectAgents: false }
                : { agent: "wired", task: "must not spawn", agentScope: "user" } }];
        }
        if (scenario === "blocked-tool" || scenario === "done-no-summary") {
          output.stopReason = "toolUse";
          output.content = [{ type: "text", text: "Synthetic done summary" },
            { type: "toolCall", id: `done-${calls}`, name: "subagent_done",
              arguments: scenario === "blocked-tool" ? { status: "blocked", summary: "Synthetic missing approval" } : {} }];
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
      return stream;
    },
  });
}
