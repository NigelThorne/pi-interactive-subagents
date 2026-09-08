import { execFile, execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  parseProcessRowsForPane,
  type ChildPiProcess,
  type PaneState,
} from "./status.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2_000;
const ROUTE_FORMAT = [
  "#{socket_path}",
  "#{pid}",
  "#{session_id}",
  "#{window_id}",
  "#{pane_id}",
].join("\t");
const PANE_PROCESS_FORMAT = ["#{pane_pid}", "#{pane_tty}"].join("\t");

export interface TmuxConnection {
  executable: string;
  socketPath: string;
  timeoutMs?: number;
}

export interface TmuxPaneRoute {
  socketPath: string;
  serverPID: number;
  serverStartTime: string;
  sessionID: string;
  windowID: string;
  paneID: string;
}

export interface TmuxSubagentProbe {
  paneState: PaneState;
  processes: ChildPiProcess[];
}

const routes = new Map<string, TmuxPaneRoute>();

function timeoutMs(connection: TmuxConnection): number {
  return connection.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function validateConnection(connection: TmuxConnection): void {
  if (!connection.executable.trim()) throw new Error("tmux executable is empty");
  if (!isAbsolute(connection.socketPath)) {
    throw new Error(`tmux socket path must be absolute: ${connection.socketPath}`);
  }
}

function runTmux(connection: TmuxConnection, args: string[]): string {
  validateConnection(connection);
  return execFileSync(connection.executable, ["-S", connection.socketPath, ...args], {
    encoding: "utf8",
    timeout: timeoutMs(connection),
  });
}

async function runTmuxAsync(connection: TmuxConnection, args: string[]): Promise<string> {
  validateConnection(connection);
  const { stdout } = await execFileAsync(
    connection.executable,
    ["-S", connection.socketPath, ...args],
    { encoding: "utf8", timeout: timeoutMs(connection) },
  );
  return stdout;
}

function runPs(args: string[], timeout: number): string {
  return execFileSync("ps", args, {
    encoding: "utf8",
    timeout,
    env: { ...process.env, LC_ALL: "C" },
  });
}

function serverStartTime(serverPID: number, timeout: number): string {
  const start = runPs(["-p", String(serverPID), "-o", "lstart="], timeout).trim();
  if (!start) throw new Error(`Could not read tmux server start time for PID ${serverPID}`);
  return start;
}

function parseRoute(raw: string, connection: TmuxConnection): TmuxPaneRoute {
  const [socketPath, pidRaw, sessionID, windowID, paneID] = raw.trim().split("\t");
  const serverPID = Number.parseInt(pidRaw ?? "", 10);
  if (socketPath !== connection.socketPath) {
    throw new Error(`tmux returned unexpected socket path: ${socketPath || "(empty)"}`);
  }
  if (!Number.isSafeInteger(serverPID) || serverPID <= 0) {
    throw new Error(`tmux returned invalid server PID: ${pidRaw || "(empty)"}`);
  }
  if (!/^\$\d+$/.test(sessionID ?? "")) {
    throw new Error(`tmux returned invalid session ID: ${sessionID || "(empty)"}`);
  }
  if (!/^@\d+$/.test(windowID ?? "")) {
    throw new Error(`tmux returned invalid window ID: ${windowID || "(empty)"}`);
  }
  if (!/^%\d+$/.test(paneID ?? "")) {
    throw new Error(`tmux returned invalid pane ID: ${paneID || "(empty)"}`);
  }
  return {
    socketPath,
    serverPID,
    serverStartTime: serverStartTime(serverPID, timeoutMs(connection)),
    sessionID,
    windowID,
    paneID,
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { killed?: boolean; signal?: string; code?: string | number };
  return value.killed === true || value.signal === "SIGTERM" || value.code === "ETIMEDOUT";
}

function sameServer(expected: TmuxPaneRoute, actual: Pick<TmuxPaneRoute, "serverPID" | "serverStartTime">): boolean {
  return expected.serverPID === actual.serverPID && expected.serverStartTime === actual.serverStartTime;
}

function currentServerIdentity(connection: TmuxConnection): Pick<TmuxPaneRoute, "serverPID" | "serverStartTime"> {
  const pidRaw = runTmux(connection, ["display-message", "-p", "#{pid}"]).trim();
  const serverPID = Number.parseInt(pidRaw, 10);
  if (!Number.isSafeInteger(serverPID) || serverPID <= 0) {
    throw new Error(`tmux returned invalid server PID: ${pidRaw || "(empty)"}`);
  }
  return {
    serverPID,
    serverStartTime: serverStartTime(serverPID, timeoutMs(connection)),
  };
}

function connectionForRoute(route: TmuxPaneRoute, override?: TmuxConnection): TmuxConnection {
  const connection = override ?? defaultTmuxConnection(route.socketPath);
  if (connection.socketPath !== route.socketPath) {
    throw new Error(`tmux connection socket does not match route: ${connection.socketPath}`);
  }
  return connection;
}

function assertServerIncarnation(route: TmuxPaneRoute, connection: TmuxConnection): void {
  const actual = currentServerIdentity(connection);
  if (!sameServer(route, actual)) {
    throw new Error(
      `tmux server incarnation changed for ${route.socketPath}; refusing action on ${route.paneID}`,
    );
  }
}

function assertCurrentRoute(route: TmuxPaneRoute, connection: TmuxConnection): TmuxPaneRoute {
  assertServerIncarnation(route, connection);
  const current = queryTmuxPaneRoute(connection, route.paneID);
  if (
    current.sessionID !== route.sessionID ||
    current.windowID !== route.windowID ||
    current.paneID !== route.paneID
  ) {
    throw new Error(`tmux pane route changed; refusing action on ${route.paneID}`);
  }
  return current;
}

export function tmuxSocketPath(tmuxEnv = process.env.TMUX): string {
  const socketPath = tmuxEnv?.split(",", 1)[0]?.trim() ?? "";
  if (!socketPath || !isAbsolute(socketPath)) {
    throw new Error("TMUX does not contain an absolute socket path");
  }
  return socketPath;
}

export function defaultTmuxConnection(socketPath = tmuxSocketPath()): TmuxConnection {
  return {
    executable: process.env.PI_SUBAGENT_TMUX_EXECUTABLE?.trim() || "tmux",
    socketPath,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

export function queryTmuxPaneRoute(connection: TmuxConnection, target: string): TmuxPaneRoute {
  if (!target.trim()) throw new Error("tmux pane target is empty");
  const route = parseRoute(
    runTmux(connection, ["display-message", "-p", "-t", target, ROUTE_FORMAT]),
    connection,
  );
  routes.set(route.paneID, route);
  return route;
}

export function currentTmuxPaneRoute(connection = defaultTmuxConnection()): TmuxPaneRoute {
  const paneID = process.env.TMUX_PANE?.trim();
  if (!paneID || !/^%\d+$/.test(paneID)) throw new Error("TMUX_PANE is not a stable pane ID");
  return queryTmuxPaneRoute(connection, paneID);
}

export function rememberedTmuxPaneRoute(paneID: string): TmuxPaneRoute | undefined {
  return routes.get(paneID);
}

export function createTmuxPane(options: {
  connection?: TmuxConnection;
  from?: TmuxPaneRoute;
  name: string;
  direction: "left" | "right" | "up" | "down";
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
}): TmuxPaneRoute {
  if (!isAbsolute(options.cwd)) throw new Error(`tmux pane cwd must be absolute: ${options.cwd}`);
  const connection = options.connection ?? defaultTmuxConnection(options.from?.socketPath);
  const from = options.from ?? currentTmuxPaneRoute(connection);
  assertCurrentRoute(from, connection);

  const args = ["split-window", "-d"];
  args.push(options.direction === "left" || options.direction === "right" ? "-h" : "-v");
  if (options.direction === "left" || options.direction === "up") args.push("-b");
  args.push("-t", from.paneID, "-c", options.cwd);

  for (const [name, value] of Object.entries(options.environment ?? {})) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment name: ${name}`);
    args.push("-e", `${name}=${value}`);
  }

  args.push("-P", "-F", "#{pane_id}");
  if (options.command) args.push(options.command);

  const paneID = runTmux(connection, args).trim();
  if (!/^%\d+$/.test(paneID)) {
    throw new Error(`Unexpected tmux split-window output: ${paneID || "(empty)"}`);
  }
  const route = queryTmuxPaneRoute(connection, paneID);
  if (route.sessionID !== from.sessionID || route.windowID !== from.windowID) {
    try {
      closeTmuxPane(route, connection);
    } catch {}
    throw new Error(`tmux created ${paneID} outside parent window ${from.windowID}`);
  }
  renameTmuxPane(route, options.name, connection);
  routes.set(route.paneID, route);
  return route;
}

export function getTmuxPaneState(route: TmuxPaneRoute, override?: TmuxConnection): PaneState {
  const connection = connectionForRoute(route, override);
  try {
    const server = currentServerIdentity(connection);
    if (!sameServer(route, server)) return "unknown";
  } catch {
    return "unknown";
  }

  try {
    const current = queryTmuxPaneRoute(connection, route.paneID);
    return current.sessionID === route.sessionID && current.windowID === route.windowID
      ? "present"
      : "unknown";
  } catch (error) {
    return isTimeoutError(error) ? "unknown" : "missing";
  }
}

export function sendTmuxCommand(
  route: TmuxPaneRoute,
  command: string,
  override?: TmuxConnection,
): void {
  const connection = connectionForRoute(route, override);
  assertCurrentRoute(route, connection);
  runTmux(connection, ["send-keys", "-t", route.paneID, "-l", "--", command]);
  runTmux(connection, ["send-keys", "-t", route.paneID, "Enter"]);
}

export function captureTmuxPane(
  route: TmuxPaneRoute,
  lines = 50,
  override?: TmuxConnection,
): string {
  const connection = connectionForRoute(route, override);
  assertCurrentRoute(route, connection);
  return runTmux(connection, [
    "capture-pane",
    "-p",
    "-J",
    "-t",
    route.paneID,
    "-S",
    `-${Math.max(1, lines)}`,
  ]);
}

export async function captureTmuxPaneAsync(
  route: TmuxPaneRoute,
  lines = 50,
  override?: TmuxConnection,
): Promise<string> {
  const connection = connectionForRoute(route, override);
  assertCurrentRoute(route, connection);
  return runTmuxAsync(connection, [
    "capture-pane",
    "-p",
    "-J",
    "-t",
    route.paneID,
    "-S",
    `-${Math.max(1, lines)}`,
  ]);
}

export function renameTmuxPane(
  route: TmuxPaneRoute,
  title: string,
  override?: TmuxConnection,
): void {
  const connection = connectionForRoute(route, override);
  assertCurrentRoute(route, connection);
  runTmux(connection, ["select-pane", "-t", route.paneID, "-T", title]);
}

export function renameTmuxWindow(
  route: TmuxPaneRoute,
  title: string,
  override?: TmuxConnection,
): void {
  const connection = connectionForRoute(route, override);
  assertCurrentRoute(route, connection);
  runTmux(connection, ["rename-window", "-t", route.windowID, title]);
}

export function renameTmuxSession(
  route: TmuxPaneRoute,
  title: string,
  override?: TmuxConnection,
): void {
  const connection = connectionForRoute(route, override);
  assertCurrentRoute(route, connection);
  runTmux(connection, ["rename-session", "-t", route.sessionID, title]);
}

export function closeTmuxPane(route: TmuxPaneRoute, override?: TmuxConnection): void {
  const connection = connectionForRoute(route, override);
  assertCurrentRoute(route, connection);
  runTmux(connection, ["kill-pane", "-t", route.paneID]);
  routes.delete(route.paneID);
}

export function probeTmuxSubagent(
  route: TmuxPaneRoute,
  sessionFile: string,
  override?: TmuxConnection,
): TmuxSubagentProbe {
  const connection = connectionForRoute(route, override);
  const paneState = getTmuxPaneState(route, connection);
  if (paneState !== "present") return { paneState, processes: [] };

  try {
    assertCurrentRoute(route, connection);
    const [panePIDRaw, paneTTY] = runTmux(connection, [
      "display-message",
      "-p",
      "-t",
      route.paneID,
      PANE_PROCESS_FORMAT,
    ]).trim().split("\t");
    const panePID = Number.parseInt(panePIDRaw ?? "", 10);
    if (!Number.isSafeInteger(panePID) || panePID <= 0 || !paneTTY) {
      return { paneState: "unknown", processes: [] };
    }
    const rows = runPs(["-axo", "pid=,ppid=,tty=,stat=,etime=,command="], timeoutMs(connection));
    return {
      paneState,
      processes: parseProcessRowsForPane(rows, sessionFile, panePID, paneTTY),
    };
  } catch {
    return { paneState: "unknown", processes: [] };
  }
}
