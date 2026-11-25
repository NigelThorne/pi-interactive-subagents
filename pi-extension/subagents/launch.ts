import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { shellEscape } from "./cmux.ts";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the pi launcher for child panes.
 *
 * tmux gives new panes the invoking client's PATH, and the parent Pi may have
 * been started (e.g. by psc) with a PATH that lacks pi. A bare `pi` then fails
 * with exit 127 before the pane can be inspected.
 */
export function resolvePiExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_SUBAGENT_PI_EXECUTABLE?.trim();
  if (override && isAbsolute(override) && isExecutableFile(override)) return override;

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, "pi");
    if (isExecutableFile(candidate)) return candidate;
  }

  const managedRoot = env.PI_MANAGED_INSTALL_ROOT?.trim();
  if (managedRoot && isAbsolute(managedRoot)) {
    const launcher = resolve(managedRoot, "..", "bin", "pi");
    if (isExecutableFile(launcher)) return launcher;
  }
  return "pi";
}

const MAX_SUBAGENT_NAME_LENGTH = 80;

/**
 * Reject display names that cannot be a deliberate label. A model that emits a
 * malformed tool call can leak the next parameter into `name`
 * (e.g. `worker</name>\n<parameter name="agent">worker`), silently dropping it.
 */
export function subagentNameError(name: string): string | undefined {
  if (/[<>]/.test(name)) {
    return (
      `Invalid subagent name ${JSON.stringify(name)}: it contains tool-call markup, which means a malformed tool call ` +
      `merged other parameters (such as agent) into name. No subagent was launched. ` +
      `Retry with name as a short plain label and agent, model, cwd and task as separate parameters.`
    );
  }
  if (!name.trim()) return "Invalid subagent name: it is empty. No subagent was launched.";
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return `Invalid subagent name ${JSON.stringify(name)}: it must be a single line without control characters. No subagent was launched.`;
  }
  if (name.length > MAX_SUBAGENT_NAME_LENGTH) {
    return `Invalid subagent name: it is longer than ${MAX_SUBAGENT_NAME_LENGTH} characters. No subagent was launched.`;
  }
  return undefined;
}

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
