import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Category launches need a durable settled marker even without global telemetry. */
export default function runtimeModelObserver(pi: ExtensionAPI) {
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle() && !ctx.hasPendingMessages()) {
      pi.appendEntry("subagent_runtime_model", { event: "settled" });
    }
  });
}
