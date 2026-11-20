import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PaneState = "present" | "missing" | "unknown";
export type SubagentLifecycle = "running" | "completed" | "unconfirmed" | "stale" | "unknown";
export type SubagentActivity = "processing" | "idle" | "unknown";

// Optional presence publishers (psc-presence, or legacy pi-session-manager-presence)
// heartbeat every 15 seconds.
const PRESENCE_MAX_AGE_MS = 45_000;

export interface StatusAgent {
  id: string;
  name: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionId?: string;
  sessionFile: string;
  doneFile: string;
  entries?: number;
  bytes?: number;
}

export interface ChildPiProcess {
  pid: number;
  ppid: number;
  tty: string;
  state: string;
  elapsed: string;
  command: string;
}

export interface SubagentStatus {
  id: string;
  name: string;
  agent?: string;
  sessionId?: string;
  sessionFile: string;
  surface: string;
  lifecycle: SubagentLifecycle;
  activity: SubagentActivity;
  activityUpdatedAt?: number;
  activityAgeSeconds?: number;
  paneState: PaneState;
  doneFileExists: boolean;
  elapsedSeconds: number;
  processes: ChildPiProcess[];
}

interface StatusProbe {
  presence?: unknown;
  doneFileExists: boolean;
  paneState: PaneState;
  processes: ChildPiProcess[];
  now: number;
}

const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;

interface ProcessRow extends ChildPiProcess {}

function parseProcessRow(line: string): ProcessRow | null {
  const match = line.match(PROCESS_ROW);
  if (!match) return null;
  const [, pid, ppid, tty, state, elapsed, command] = match;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    tty,
    state,
    elapsed,
    command,
  };
}

function isPiProcess(process: ProcessRow): boolean {
  const executable = process.command.trim().split(/\s+/, 1)[0];
  return executable === "pi" || executable.endsWith("/pi");
}

function parseRows(output: string): ProcessRow[] {
  return output
    .split("\n")
    .map(parseProcessRow)
    .filter((process): process is ProcessRow => process !== null);
}

function ancestryMatches(
  process: ProcessRow,
  byPid: Map<number, ProcessRow>,
  predicate: (ancestor: ProcessRow) => boolean,
): boolean {
  const visited = new Set<number>();
  let current: ProcessRow | undefined = process;
  while (current && !visited.has(current.pid)) {
    if (predicate(current)) return true;
    visited.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

export function parseProcessRows(output: string, sessionFile: string): ChildPiProcess[] {
  const rows = parseRows(output);
  const byPid = new Map(rows.map((process) => [process.pid, process]));
  return rows.filter(
    (process) =>
      isPiProcess(process) &&
      ancestryMatches(process, byPid, (ancestor) => ancestor.command.includes(sessionFile)),
  );
}

export function parseProcessRowsForPane(
  output: string,
  sessionFile: string,
  panePID: number,
  paneTTY: string,
): ChildPiProcess[] {
  const rows = parseRows(output);
  const byPid = new Map(rows.map((process) => [process.pid, process]));
  const normalizedTTY = paneTTY.replace(/^\/dev\//, "");

  return rows.filter(
    (process) =>
      isPiProcess(process) &&
      process.tty.replace(/^\/dev\//, "") === normalizedTTY &&
      ancestryMatches(process, byPid, (ancestor) => ancestor.pid === panePID) &&
      ancestryMatches(process, byPid, (ancestor) => ancestor.command.includes(sessionFile)),
  );
}

export function listChildPiProcesses(sessionFile: string): ChildPiProcess[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,tty=,stat=,etime=,command="], {
    encoding: "utf8",
  });
  return parseProcessRows(output, sessionFile);
}

export function defaultPscPresenceDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME : join(env.HOME ?? homedir(), ".local", "state");
  return join(state, "psc", "presence");
}

function readJson(directory: string, sessionId: string): unknown {
  try {
    return JSON.parse(readFileSync(join(directory, `${encodeURIComponent(sessionId)}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Optional telemetry, not a liveness probe. Prefers psc-presence records
 * (normalised to the legacy {sessionID, state} shape), falling back to the
 * legacy pi-session-manager-presence record. A psc record without a known
 * `activity` yields no state, so activity stays unknown.
 */
export function readSubagentPresence(
  sessionId: string | undefined,
  directory = join(homedir(), ".pi", "agent", "session-manager", "live"),
  pscDirectory = defaultPscPresenceDir(),
): unknown {
  if (!sessionId) return undefined;
  const psc = readJson(pscDirectory, sessionId) as Record<string, unknown> | undefined;
  if (psc && typeof psc === "object") {
    const state = psc.activity === "working" ? "processing" : psc.activity === "idle" ? "idle" : undefined;
    return {
      sessionID: psc.sessionId,
      sessionFile: psc.sessionFile,
      pid: psc.pid,
      updatedAt: psc.updatedAt,
      ...(state ? { state } : {}),
    };
  }
  return readJson(directory, sessionId);
}

export function formatSubagentStatus(status: SubagentStatus): string {
  const processes = status.processes
    .map((process) => `pid=${process.pid} tty=${process.tty} elapsed=${process.elapsed}`)
    .join(", ");
  return [
    `name=${JSON.stringify(status.name)}`,
    ...(status.lifecycle === "running" ? [`steerTarget=${JSON.stringify(status.id)} (use as subagent_steer.target)`] : []),
    `lifecycle=${status.lifecycle}`,
    `activity=${status.activity}`,
    ...(status.activityAgeSeconds !== undefined ? [`activityObservedAgo=${status.activityAgeSeconds}s`] : []),
    `pane=${status.paneState}`,
    `doneFile=${status.doneFileExists ? "present" : "absent"}`,
    `childPi=${processes || "not found"}`,
  ].join("; ");
}

export function inspectSubagentStatus(agent: StatusAgent, probe: StatusProbe): SubagentStatus {
  const lifecycle: SubagentLifecycle = probe.doneFileExists
    ? "completed"
    : probe.processes.length > 0
      ? "running"
      : probe.paneState === "present"
        ? "unconfirmed"
        : probe.paneState === "missing"
          ? "stale"
          : "unknown";

  // Presence is advisory. Only accept a fresh record for this exact live child.
  // Missing telemetry must never turn process liveness into a claim of activity.
  const presence = probe.presence as Record<string, unknown> | null | undefined;
  let activity: SubagentActivity = "unknown";
  let activityUpdatedAt: number | undefined;
  if (
    lifecycle === "running" &&
    probe.processes.length === 1 &&
    presence && typeof presence === "object" &&
    agent.sessionId && presence.sessionID === agent.sessionId &&
    presence.sessionFile === agent.sessionFile &&
    presence.pid === probe.processes[0].pid &&
    (presence.state === "idle" || presence.state === "processing") &&
    typeof presence.updatedAt === "number" && Number.isFinite(presence.updatedAt) &&
    presence.updatedAt >= agent.startTime &&
    presence.updatedAt <= probe.now &&
    probe.now - presence.updatedAt <= PRESENCE_MAX_AGE_MS
  ) {
    activity = presence.state;
    activityUpdatedAt = presence.updatedAt;
  }

  return {
    id: agent.id,
    name: agent.name,
    ...(agent.agent ? { agent: agent.agent } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    sessionFile: agent.sessionFile,
    surface: agent.surface,
    lifecycle,
    activity,
    ...(activityUpdatedAt !== undefined ? {
      activityUpdatedAt,
      activityAgeSeconds: Math.floor((probe.now - activityUpdatedAt) / 1000),
    } : {}),
    paneState: probe.paneState,
    doneFileExists: probe.doneFileExists,
    elapsedSeconds: Math.max(0, Math.floor((probe.now - agent.startTime) / 1000)),
    processes: probe.processes,
  };
}
