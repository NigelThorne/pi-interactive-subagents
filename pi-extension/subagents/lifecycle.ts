import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import type { SessionEntry } from "./session.ts";

export type CompletionStatus = "completed" | "reported" | "blocked" | "failed";
export interface Completion {
  status: CompletionStatus;
  summary: string;
}

function validCompletion(value: any): value is Completion {
  return value && ["completed", "reported", "blocked", "failed"].includes(value.status) &&
    typeof value.summary === "string" && !!value.summary.trim();
}

export function writeCompletion(summaryFile: string, completion: Completion): void {
  writeFileSync(summaryFile, completion.summary, "utf8");
  writeFileSync(`${summaryFile}.json`, JSON.stringify(completion), "utf8");
}

export function readCompletion(doneFile: string): Completion | undefined {
  try {
    const value = JSON.parse(readFileSync(`${doneFile}.summary.json`, "utf8"));
    return validCompletion(value) ? value : undefined;
  } catch { return undefined; }
}

/** An OS exit or a normal final response is not a claim that the task succeeded. */
export function completionFromEntries(entries: SessionEntry[], explicit?: Completion): Completion {
  let assistant: any;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom_message") break;
    if (entry.type !== "message") continue;
    const message = entry.message as any;
    if (message?.role === "user") break;
    if (message?.role === "assistant") { assistant = message; break; }
  }
  const text = assistant?.content?.filter((block: any) => block.type === "text")
    .map((block: any) => block.text).join("\n").trim() || "";
  const reason = assistant?.stopReason;
  if (["error", "aborted", "length"].includes(reason)) {
    return { status: "failed", summary: `Subagent stopped (${reason}).\n${assistant.errorMessage || text || "No result was produced."}` };
  }
  if (explicit) return explicit;
  if (reason === "stop" && text) return { status: "reported", summary: text };
  return { status: "failed", summary: `Subagent became idle without a final result${reason ? ` (${reason})` : ""}.` };
}

/** Only a current run's settled event authorizes the parent idle fallback. */
export function getSettledCompletion(entries: SessionEntry[]): { key: string; completion: Completion } | null {
  let settled: { key: string; completion: Completion } | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const data = entry.data as any;
    if (entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction") {
      settled = null;
    }
    if (entry.type !== "custom") continue;
    if (entry.customType === "timeline-telemetry") {
      if (["agent_start", "turn_start", "compaction_start", "auto_retry_start"].includes(data?.event)) settled = null;
      if (data?.event === "agent_settled") {
        settled = { key: entry.id, completion: completionFromEntries(entries.slice(0, i)) };
      }
    }
    if (entry.customType === "subagent_lifecycle" && data?.event === "settled" && validCompletion(data.completion)) {
      settled = { key: entry.id, completion: data.completion };
    }
    if (entry.customType === "subagent_runtime_model" && data?.event === "settled") {
      settled = { key: entry.id, completion: completionFromEntries(entries.slice(0, i)) };
    }
  }
  return settled;
}

type Timers = Pick<typeof globalThis, "setInterval" | "clearInterval">;

/** Auto-exit workers are unattended. Steering must not permanently disable cleanup. */
export function registerAutoExit(
  pi: ExtensionAPI,
  enabled: boolean,
  summaryFile?: string,
  timers: Timers = globalThis,
): void {
  if (!enabled) return;
  let ctx: ExtensionContext | undefined;
  let started = false;
  let closing = false;
  let baseline = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const finishIfIdle = () => {
    if (!ctx || !started || closing || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    closing = true;
    const entries = ctx.sessionManager.getBranch().filter((entry) => !baseline.has(entry.id)) as SessionEntry[];
    const explicit = summaryFile ? readCompletion(summaryFile.replace(/\.summary$/, "")) : undefined;
    let completion = completionFromEntries(entries, explicit);
    try {
      if (summaryFile) writeCompletion(summaryFile, completion);
    } catch (error) {
      completion = { status: "failed", summary: `${completion.summary}\nCould not persist completion: ${String(error)}` };
    }
    try {
      pi.appendEntry("subagent_lifecycle", { event: "settled", completion });
    } finally {
      ctx.shutdown();
    }
  };

  pi.on("session_start", (_event, context) => {
    ctx = context;
    baseline = new Set(context.sessionManager.getBranch().map((entry) => entry.id));
    started = false;
    closing = false;
    if (timer) timers.clearInterval(timer);
    // The timer covers runtimes/extensions that miss a settled callback. isIdle
    // includes retries and compaction; pending messages must also be drained.
    timer = timers.setInterval(finishIfIdle, 1000);
  });
  pi.on("agent_start", (_event, context) => { ctx = context; started = true; });
  pi.on("agent_settled", (_event, context) => { ctx = context; finishIfIdle(); });
  pi.on("session_shutdown", () => {
    if (timer) timers.clearInterval(timer);
    timer = undefined;
    ctx = undefined;
  });
}
