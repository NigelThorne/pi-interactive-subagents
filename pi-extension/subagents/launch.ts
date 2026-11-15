import { shellEscape } from "./cmux.ts";

/** Always override a multiplexer server's possibly stale inherited value. */
export function autoExitEnv(enabled: boolean): string {
  return `PI_SUBAGENT_AUTO_EXIT=${enabled ? "1" : "0"}`;
}

export function resumeAutoExit(message?: string): boolean {
  return !!message?.trim();
}

/** Pi's --tools applies to extension tools as well as built-ins. */
export function completionTools(tools?: string): string | undefined {
  if (tools === undefined) return undefined;
  return [...new Set([...tools.split(",").map((tool) => tool.trim()).filter(Boolean), "subagent_done"])].join(",");
}

export function wrapChildCommand(command: string, doneFile: string, cleanupFile?: string): string {
  return `${command}; pi_status=$?;${cleanupFile ? ` rm -f ${shellEscape(cleanupFile)};` : ""} printf '%s\\n' "$pi_status" > ${shellEscape(doneFile)}`;
}
