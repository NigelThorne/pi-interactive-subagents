import { execSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import {
  closePane as zellijClosePane,
  createPaneInSameTab as zellijCreatePaneInSameTab,
  ensureCurrentTabReadyForSubagents,
  readScreen as zellijReadScreen,
  readScreenAsync as zellijReadScreenAsync,
  renameCurrentPane as zellijRenameCurrentPane,
  renameCurrentTab as zellijRenameCurrentTab,
  renameSession as zellijRenameSession,
  sendCommand as zellijSendCommand,
} from "./zellij.ts";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "cmux" || pref === "tmux" || pref === "zellij") return pref;
  return null;
}

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;

  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

/**
 * `set_tab_title` relies on Zellij's stable pane/tab targeting. Do not expose
 * it in other terminals, where a failed rename can terminate the Pi process.
 */
export function isTabTitleSupported(backend: MuxBackend | null = getMuxBackend()): boolean {
  return backend === "zellij";
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref === "cmux") {
    return "Start pi inside cmux (`cmux pi`).";
  }
  if (pref === "tmux") {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  }
  if (pref === "zellij") {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  }
  return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), or zellij (`zellij --session pi`, then run `pi`).";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function captureExitStatusCommand(filePath: string): string {
  if (isFishShell()) {
    return `set -l __pi_subagent_exit_status $status; printf '%s\\n' $__pi_subagent_exit_status > ${shellEscape(filePath)}; echo '__SUBAGENT_DONE_'$__pi_subagent_exit_status'__'`;
  }
  return `__pi_subagent_exit_status=$?; printf '%s\\n' "$__pi_subagent_exit_status" > ${shellEscape(filePath)}; echo '__SUBAGENT_DONE_'$__pi_subagent_exit_status'__'`;
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Create a new terminal pane as a right split and set its title.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij).
 */
export function createSurface(name: string, command?: string): string {
  return createSurfaceSplit(name, "right", undefined, command);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  command?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceArg = fromSurface ? ` --surface ${shellEscape(fromSurface)}` : "";
    const out = execSync(`cmux new-split ${direction}${surfaceArg}`, {
      encoding: "utf8",
    }).trim();
    const match = out.match(/surface:\d+/);
    if (!match) {
      throw new Error(`Unexpected cmux new-split output: ${out}`);
    }
    const surface = match[0];
    execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, {
      encoding: "utf8",
    });
    return surface;
  }

  if (backend === "tmux") {
    const args = ["split-window"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    try {
      execFileSync("tmux", ["select-pane", "-t", pane, "-T", name], { encoding: "utf8" });
    } catch {
      // Optional.
    }
    return pane;
  }

  return zellijCreatePaneInSameTab({
    name,
    direction,
    fromSurface,
    cwd: process.cwd(),
    command,
  });
}

/**
 * Ensure the current session is ready to orchestrate subagents.
 * For zellij this reuses the current tab when it already belongs just to this
 * pi session, otherwise it moves the current pi pane into a fresh tab via the
 * local break-pane plugin and renames that tab.
 */
export function prepareForSubagents(title: string, ownedSurfaces: string[] = []): void {
  const backend = requireMuxBackend();

  if (backend === "zellij") {
    ensureCurrentTabReadyForSubagents(title, ownedSurfaces);
    return;
  }

  renameCurrentTab(title);
}

/**
 * Rename the current pane when supported.
 */
export function renameCurrentPane(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return;
  }

  if (backend === "tmux") {
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    execFileSync("tmux", ["select-pane", "-t", paneId, "-T", title], { encoding: "utf8" });
    return;
  }

  zellijRenameCurrentPane(title);
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }

  zellijRenameCurrentTab(title);
}

/**
 * Rename the current workspace/session where supported.
 */
export function shouldRenameWorkspace(backend: MuxBackend): boolean {
  if (backend === "tmux") {
    return process.env.PI_SUBAGENT_RENAME_TMUX_SESSION === "1";
  }

  if (backend === "zellij") {
    return false;
  }

  return true;
}

export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (!shouldRenameWorkspace(backend)) {
    return;
  }

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }

  zellijRenameSession(title);
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }

  zellijSendCommand(surface, command);
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, {
      encoding: "utf8",
    });
  }

  if (backend === "tmux") {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      {
        encoding: "utf8",
      },
    );
  }

  return zellijReadScreen(surface, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }

  return zellijReadScreenAsync(surface, lines);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    return;
  }

  zellijClosePane(surface);
}

/**
 * Poll a pane until the __SUBAGENT_DONE_N__ sentinel appears.
 * Returns the process exit code embedded in the sentinel.
 * Throws if the signal is aborted before the sentinel is found.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: { interval: number; onTick?: (elapsed: number) => void },
): Promise<number> {
  const start = Date.now();

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const screen = await readScreenAsync(surface, 5);
    const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
    if (match) {
      return parseInt(match[1], 10);
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
