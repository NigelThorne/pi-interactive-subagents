/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { registerAutoExit, writeCompletion } from "./lifecycle.ts";
import { findLastAssistantMessage, type SessionEntry } from "./session.ts";

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    renderWidget(ctx, null);
  });

  registerAutoExit(pi, autoExit, process.env.PI_SUBAGENT_SUMMARY_FILE);

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({
        enum: ["completed", "blocked", "failed"],
        description: "Task outcome. Use blocked or failed when the parent must resolve a problem. Defaults to completed.",
      })),
      summary: Type.Optional(
        Type.String({
          description:
            "Concise verdict/result for the parent. Include findings, blockers, or what was completed.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Pi may append a final "Done." assistant message after shutdown. Persist
      // the model-supplied verdict out-of-band so the parent receives it exactly.
      const summaryFile = process.env.PI_SUBAGENT_SUMMARY_FILE;
      if (summaryFile) {
        writeCompletion(summaryFile, {
          status: params.status === "blocked" || params.status === "failed" ? params.status : "completed",
          summary: params.summary?.trim() ||
            findLastAssistantMessage(ctx.sessionManager.getBranch() as SessionEntry[]) ||
            "Subagent reported completion without a summary.",
        });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
        terminate: true,
      };
    },
  });
}
