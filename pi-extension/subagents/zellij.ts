import { execFile, execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ZellijPaneInfo {
  id: number;
  is_plugin: boolean;
  is_selectable?: boolean;
  is_focused?: boolean;
  is_floating?: boolean;
  title?: string;
  tab_id: number;
  tab_name?: string;
  pane_command?: string;
}

export interface ZellijTabInfo {
  tab_id: number;
  position: number;
  name: string;
  active: boolean;
  selectable_tiled_panes_count?: number;
  selectable_floating_panes_count?: number;
}

export function normalizePaneId(surface: string): string {
  if (surface.startsWith("pane:")) return surface.slice("pane:".length);
  if (surface.startsWith("terminal_")) return surface.slice("terminal_".length);
  return surface;
}

export function paneSurface(paneId: string | number): string {
  return `pane:${normalizePaneId(String(paneId))}`;
}

function envForPane(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = normalizePaneId(surface);
  }
  return env;
}

export function actionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", ["action", ...args], {
    encoding: "utf8",
    env: envForPane(surface),
  });
}

export async function actionAsync(args: string[], surface?: string): Promise<string> {
  const { stdout } = await execFileAsync("zellij", ["action", ...args], {
    encoding: "utf8",
    env: envForPane(surface),
  });
  return stdout;
}

function shellCommandArgs(command: string): string[] {
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  const shellName = basename(shell);
  if (shellName === "fish") {
    return [shell, "-c", command];
  }
  return [shell, "-lc", command];
}

function currentPaneSurface(): string {
  const paneId = process.env.ZELLIJ_PANE_ID?.trim();
  if (!paneId) {
    throw new Error("ZELLIJ_PANE_ID not set");
  }
  return paneSurface(paneId);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function selectablePaneIdsForTab(tabId: number, panes: ZellijPaneInfo[]): string[] {
  return panes
    .filter((pane) => pane.tab_id === tabId && !pane.is_plugin && pane.is_selectable !== false)
    .map((pane) => normalizePaneId(String(pane.id)));
}

function newPaneIdFromDiff(beforeIds: Set<string>, tabId: number): string {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const panes = listPanes();
    const created = selectablePaneIdsForTab(tabId, panes).find((id) => !beforeIds.has(id));
    if (created) {
      return created;
    }
    sleep(25);
  }
  throw new Error("Timed out discovering newly created zellij pane");
}

export function listPanes(): ZellijPaneInfo[] {
  return JSON.parse(actionSync(["list-panes", "--json", "--all", "--tab", "--state", "--command"]));
}

export function listTabs(): ZellijTabInfo[] {
  return JSON.parse(actionSync(["list-tabs", "--json", "--all", "--state", "--panes"]));
}

export function getCurrentTabInfo(): ZellijTabInfo {
  return getTabInfoForPane(currentPaneSurface());
}

export function getPaneInfo(surface: string): ZellijPaneInfo {
  const paneId = normalizePaneId(surface);
  const pane = listPanes().find(
    (candidate) => !candidate.is_plugin && normalizePaneId(String(candidate.id)) === paneId,
  );
  if (!pane) {
    throw new Error(`Could not find zellij pane ${surface}`);
  }
  return pane;
}

export function getTabIdForPane(surface: string): number {
  return getPaneInfo(surface).tab_id;
}

export function getTabInfoForPane(surface: string): ZellijTabInfo {
  const tabId = getTabIdForPane(surface);
  const tab = listTabs().find((candidate) => candidate.tab_id === tabId);
  if (!tab) {
    throw new Error(`Could not find zellij tab for pane ${surface}`);
  }
  return tab;
}

export function focusPane(surface: string): void {
  actionSync(["focus-pane-id", normalizePaneId(surface)], surface);
}

export function renamePane(surface: string, title: string): void {
  actionSync(["rename-pane", "--pane-id", normalizePaneId(surface), title], surface);
}

export function renameCurrentPane(title: string): void {
  renamePane(currentPaneSurface(), title);
}

export function renameTab(tabId: number, title: string, surface?: string): void {
  actionSync(["rename-tab", "--tab-id", String(tabId), title], surface);
}

export function renameCurrentTab(title: string): void {
  const current = getCurrentTabInfo();
  renameTab(current.tab_id, title, currentPaneSurface());
}

export function renameTabForPane(surface: string, title: string): void {
  renameTab(getTabIdForPane(surface), title, surface);
}

export function renameSession(title: string): void {
  actionSync(["rename-session", title], currentPaneSurface());
}

export function createPaneInSameTab(options: {
  name: string;
  direction: "left" | "right" | "up" | "down";
  fromSurface?: string;
  cwd?: string;
  command?: string;
}): string {
  const sourceSurface = options.fromSurface ?? currentPaneSurface();
  const sourcePaneId = normalizePaneId(sourceSurface);
  const tabId = getTabIdForPane(sourceSurface);
  const directionArg =
    options.direction === "left" || options.direction === "right" ? "right" : "down";
  const beforeIds = new Set(selectablePaneIdsForTab(tabId, listPanes()));

  const args = [
    "new-pane",
    "--tab-id",
    String(tabId),
    "--direction",
    directionArg,
    "--name",
    options.name,
    "--cwd",
    options.cwd ?? process.cwd(),
  ];
  if (options.command) {
    args.push("--close-on-exit", "--", ...shellCommandArgs(options.command));
  }

  const createdRaw = actionSync(args, sourceSurface).trim();
  const createdPaneId = createdRaw
    ? normalizePaneId(createdRaw)
    : newPaneIdFromDiff(beforeIds, tabId);
  const createdSurface = paneSurface(createdPaneId);

  if (options.direction === "left" || options.direction === "up") {
    try {
      actionSync(["move-pane", "--pane-id", createdPaneId, options.direction], createdSurface);
    } catch {
      // Optional layout polish.
    }
  }

  try {
    renamePane(createdSurface, options.name);
  } catch {
    // Optional.
  }

  try {
    focusPane(paneSurface(sourcePaneId));
  } catch {
    // Best effort only.
  }

  return createdSurface;
}

export function sendCommand(surface: string, command: string): void {
  const paneId = normalizePaneId(surface);
  execFileSync("zellij", ["action", "paste", "--pane-id", paneId, command], {
    encoding: "utf8",
    env: envForPane(surface),
  });
  execFileSync("zellij", ["action", "send-keys", "--pane-id", paneId, "Enter"], {
    encoding: "utf8",
    env: envForPane(surface),
  });
}

export function readScreen(surface: string, lines = 50): string {
  const tmpPath = join(
    tmpdir(),
    `pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  try {
    actionSync(["dump-screen", "--path", tmpPath, "--pane-id", normalizePaneId(surface)], surface);
    const raw = readFileSync(tmpPath, "utf8");
    const split = raw.split("\n");
    return split.length <= lines ? raw : split.slice(-lines).join("\n");
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
  }
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const tmpPath = join(
    tmpdir(),
    `pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  try {
    await actionAsync(["dump-screen", "--path", tmpPath, "--pane-id", normalizePaneId(surface)], surface);
    const raw = readFileSync(tmpPath, "utf8");
    const split = raw.split("\n");
    return split.length <= lines ? raw : split.slice(-lines).join("\n");
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
  }
}

export function closePane(surface: string): void {
  try {
    actionSync(["close-pane", "--pane-id", normalizePaneId(surface)], surface);
  } catch {
    // Pane may already be gone.
  }
}
