import { execSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { accessSync, constants } from "node:fs";
import {
  captureTmuxPane,
  captureTmuxPaneAsync,
  closeTmuxPane,
  createTmuxPane,
  currentTmuxPaneRoute,
  defaultTmuxConnection,
  getTmuxPaneState,
  probeTmuxSubagent,
  queryTmuxPaneRoute,
  rememberedTmuxPaneRoute,
  renameTmuxPane,
  renameTmuxSession,
  renameTmuxWindow,
  sendTmuxCommand,
  type TmuxPaneRoute,
} from "./tmux.ts";
import type { ChildPiProcess, PaneState } from "./status.ts";
import {
  closePane as zellijClosePane,
  createPaneInSameTab as zellijCreatePaneInSameTab,
  readScreen as zellijReadScreen,
  readScreenAsync as zellijReadScreenAsync,
  renameCurrentPane as zellijRenameCurrentPane,
  renameCurrentTab as zellijRenameCurrentTab,
  renameSession as zellijRenameSession,
  sendCommand as zellijSendCommand,
} from "./zellij.ts";
import {
  closeBlock as rexCloseBlock,
  createBlock as rexCreateBlock,
  readScreen as rexReadScreen,
  readScreenAsync as rexReadScreenAsync,
  renameCurrentBlock as rexRenameCurrentBlock,
  renameCurrentWindow as rexRenameCurrentWindow,
  renameSession as rexRenameSession,
  sendCommand as rexSendCommand,
} from "./rex.ts";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "rex";

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
  if (pref === "cmux" || pref === "tmux" || pref === "zellij" || pref === "rex") return pref;
  return null;
}

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return false;
  const configured = process.env.PI_SUBAGENT_TMUX_EXECUTABLE?.trim();
  if (!configured) return hasCommand("tmux");
  try {
    accessSync(configured, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function isRexRuntimeAvailable(): boolean {
  return !!process.env.REX_SESSION && !!process.env.REX_BLOCK && hasCommand("rex");
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

export function isRexAvailable(): boolean {
  return isRexRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
  if (pref === "rex") return isRexRuntimeAvailable() ? "rex" : null;

  // A real tmux pane is the strongest runtime signal. Do not let inherited
  // cmux variables route pane actions away from the process's actual parent.
  // Rex ranks above cmux/zellij for the same reason: REX_BLOCK identifies the
  // process's actual pane, while cmux/zellij variables can be inherited.
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isRexRuntimeAvailable()) return "rex";
  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

/**
 * `set_tab_title` is exposed only where stable pane/window targeting is available.
 */
export function isTabTitleSupported(backend: MuxBackend | null = getMuxBackend()): boolean {
  return backend === "tmux" || backend === "zellij" || backend === "rex";
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
  if (pref === "rex") {
    return "Start pi inside a Rex terminal (`rex run -- pi` or run `pi` in a Rex pane).";
  }
  return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or a Rex terminal.";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

function requireTmuxRoute(surface: string): TmuxPaneRoute {
  return rememberedTmuxPaneRoute(surface) ?? queryTmuxPaneRoute(defaultTmuxConnection(), surface);
}

export function getSurfaceState(surface: string): PaneState {
  const backend = getMuxBackend();
  if (!backend) return "unknown";
  if (backend === "tmux") return getTmuxPaneState(requireTmuxRoute(surface));
  try {
    readScreen(surface, 1);
    return "present";
  } catch {
    return "missing";
  }
}

export function probeSurfaceSubagent(
  surface: string,
  sessionFile: string,
): { paneState: PaneState; processes: ChildPiProcess[] } | null {
  if (getMuxBackend() !== "tmux") return null;
  return probeTmuxSubagent(requireTmuxRoute(surface), sessionFile);
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
export function createSurface(name: string, command?: string, cwd = process.cwd()): string {
  return createSurfaceSplit(name, "right", undefined, command, cwd);
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
  cwd = process.cwd(),
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
    const connection = defaultTmuxConnection();
    const from = fromSurface
      ? rememberedTmuxPaneRoute(fromSurface) ?? queryTmuxPaneRoute(connection, fromSurface)
      : currentTmuxPaneRoute(connection);
    const environment = Object.fromEntries(
      ["PTC_ALLOW_UNSANDBOXED_SUBPROCESS", "PTC_USE_DOCKER"]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    return createTmuxPane({
      connection,
      from,
      name,
      direction,
      cwd,
      command,
      environment,
    }).paneID;
  }

  if (backend === "rex") {
    return rexCreateBlock({
      name,
      direction,
      fromSurface,
      cwd,
      command,
    });
  }

  return zellijCreatePaneInSameTab({
    name,
    direction,
    fromSurface,
    cwd,
    command,
  });
}

/**
 * Label the current tab before spawning subagents. Subagent panes are always
 * created in the main pi pane's existing tab.
 */
export function prepareForSubagents(title: string): void {
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
    renameTmuxPane(currentTmuxPaneRoute(), title);
    return;
  }

  if (backend === "rex") {
    rexRenameCurrentBlock(title);
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
    renameTmuxWindow(currentTmuxPaneRoute(), title);
    return;
  }

  if (backend === "rex") {
    rexRenameCurrentWindow(title);
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

  if (backend === "zellij" || backend === "rex") {
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
    renameTmuxSession(currentTmuxPaneRoute(), title);
    return;
  }

  if (backend === "rex") {
    rexRenameSession(title);
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
    sendTmuxCommand(requireTmuxRoute(surface), command);
    return;
  }

  if (backend === "rex") {
    rexSendCommand(surface, command);
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
    return captureTmuxPane(requireTmuxRoute(surface), lines);
  }

  if (backend === "rex") {
    return rexReadScreen(surface, lines);
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
    return captureTmuxPaneAsync(requireTmuxRoute(surface), lines);
  }

  if (backend === "rex") {
    return rexReadScreenAsync(surface, lines);
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
    closeTmuxPane(requireTmuxRoute(surface));
    return;
  }

  if (backend === "rex") {
    rexCloseBlock(surface);
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
