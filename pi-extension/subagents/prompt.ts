export function buildCompletionInstructions(_options?: { autoExit?: boolean }): string {
  // `agent_end` is not reliable enough as the sole completion signal across
  // Pi runtimes. Every interactive subagent must explicitly close itself.
  return [
    "Before finishing your turn, send a concise summary of what you accomplished.",
    "Immediately after that summary, call the `subagent_done` tool to return control to the parent agent.",
    "Do not end the turn after only writing the summary; the `subagent_done` tool call is required.",
  ].join("\n");
}

export function buildResumeFollowupMessage(message: string): string {
  return `${message}\n\nWhen you complete this follow-up:\n${buildCompletionInstructions()}\nDo not wait for further input once finished.`;
}
