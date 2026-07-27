export function buildCompletionInstructions(options?: { autoExit?: boolean }): string {
  if (options?.autoExit) {
    return "Before finishing your turn, include a concise summary of what you accomplished.";
  }

  return [
    "Before finishing your turn, send a concise summary of what you accomplished.",
    "Immediately after that summary, call the `subagent_done` tool to return control to the parent agent.",
    "Do not end the turn after only writing the summary; the `subagent_done` tool call is required.",
  ].join("\n");
}

export function buildResumeFollowupMessage(message: string): string {
  return `${message}\n\nWhen you complete this follow-up:\n${buildCompletionInstructions()}\nDo not wait for further input once finished.`;
}
