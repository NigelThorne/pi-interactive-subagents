import { execFile, execFileSync } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function rexSync(args: string[]): string {
  return execFileSync("rex", args, { encoding: "utf8" });
}

async function rexAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("rex", args, { encoding: "utf8" });
  return stdout;
}

export function currentRexSession(): string {
  const session = process.env.REX_SESSION?.trim();
  if (!session) throw new Error("REX_SESSION not set");
  return session;
}

export function currentRexBlock(): string {
  const block = process.env.REX_BLOCK?.trim();
  if (!block) throw new Error("REX_BLOCK not set");
  return block;
}

function shellCommandArgs(command: string): string[] {
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  if (basename(shell) === "fish") {
    return [shell, "-c", command];
  }
  return [shell, "-lc", command];
}

const DIRECTION_MAP = {
  left: "left",
  right: "right",
  up: "above",
  down: "below",
} as const;

/**
 * Create a new block as a split beside an anchor block.
 * Returns the full block ID (`block:<uuid>`).
 *
 * `--keep-open` keeps the terminal alive after the command exits so the
 * `__SUBAGENT_DONE_N__` sentinel remains visible to pollForExit.
 */
export function createBlock(options: {
  name: string;
  direction: "left" | "right" | "up" | "down";
  fromSurface?: string;
  cwd?: string;
  command?: string;
}): string {
  const args = [
    "split",
    "-s",
    currentRexSession(),
    "-b",
    options.fromSurface ?? currentRexBlock(),
    "--split",
    DIRECTION_MAP[options.direction],
    "-c",
    options.cwd ?? process.cwd(),
    "--label",
    options.name,
    "--keep-open",
    "--focus=false",
    "--json",
  ];
  if (options.command) {
    args.push("--shell=none", "--", ...shellCommandArgs(options.command));
  }

  const out = rexSync(args).trim();
  let blockId: string | undefined;
  try {
    blockId = JSON.parse(out)?.block_ids?.[0];
  } catch {
    // Fall through to the error below.
  }
  if (!blockId) {
    throw new Error(`Unexpected rex split output: ${out}`);
  }
  return blockId;
}

/**
 * Send a command string to a block and press Enter to execute it.
 */
export function sendCommand(surface: string, command: string): void {
  rexSync(["send", "-b", surface, command]);
  rexSync(["send-key", "-b", surface, "enter"]);
}

export function readScreen(surface: string, lines = 50): string {
  const raw = rexSync(["capture", "-b", surface]);
  const split = raw.split("\n");
  return split.length <= lines ? raw : split.slice(-lines).join("\n");
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const raw = await rexAsync(["capture", "-b", surface]);
  const split = raw.split("\n");
  return split.length <= lines ? raw : split.slice(-lines).join("\n");
}

export function closeBlock(surface: string): void {
  try {
    rexSync(["block", "close", surface]);
  } catch {
    // Block may already be gone.
  }
}

export function renameBlock(surface: string, title: string): void {
  rexSync(["block", "rename", surface, title]);
}

export function renameCurrentBlock(title: string): void {
  renameBlock(currentRexBlock(), title);
}

function windowIdForBlock(surface: string): string {
  const out = rexSync(["block", "inspect", surface, "--json"]);
  const windowId = JSON.parse(out)?.block?.window_id;
  if (!windowId) {
    throw new Error(`Could not determine rex window for block ${surface}`);
  }
  return windowId;
}

export function renameCurrentWindow(title: string): void {
  rexSync([
    "window",
    "rename",
    windowIdForBlock(currentRexBlock()),
    title,
    "-s",
    currentRexSession(),
  ]);
}

export function renameSession(title: string): void {
  rexSync(["session", "rename", currentRexSession(), title]);
}
