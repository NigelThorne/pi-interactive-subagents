export function buildCompletionInstructions(_options?: { autoExit?: boolean }): string {
  // `agent_end` is not reliable enough as the sole completion signal across
  // Pi runtimes. Every interactive subagent must explicitly close itself.
  return [
    "Before finishing your turn, send a concise summary of what you accomplished.",
    "Immediately after that summary, call the `subagent_done` tool with a `summary` argument containing the same concise verdict, to return control to the parent agent.",
    "Do not end the turn after only writing the summary; the `subagent_done` tool call is required.",
  ].join("\n");
}

export function buildParentCompletionHandoffInstructions(): string {
  return [
    "A subagent returns its completion summary automatically as a steer message.",
    "Call `subagent_status` before claiming that the child Pi process is live.",
    "Do not block the parent session. Do not run `sleep` or manually poll logs, worktrees, panes, or session files for completion.",
    "Do unrelated bounded work if any remains. End the turn if no independent work remains, so the parent stays available for user messages.",
  ].join(" ");
}

export function buildResumeFollowupMessage(message: string): string {
  return `${message}\n\nWhen you complete this follow-up:\n${buildCompletionInstructions()}\nDo not wait for further input once finished.`;
}
