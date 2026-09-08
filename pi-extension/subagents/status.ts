import { execFileSync } from "node:child_process";

export type PaneState = "present" | "missing" | "unknown";
export type SubagentLifecycle = "running" | "completed" | "unconfirmed" | "stale" | "unknown";

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
  paneState: PaneState;
  doneFileExists: boolean;
  elapsedSeconds: number;
  processes: ChildPiProcess[];
}

interface StatusProbe {
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

export function formatSubagentStatus(status: SubagentStatus): string {
  const processes = status.processes
    .map((process) => `pid=${process.pid} tty=${process.tty} elapsed=${process.elapsed}`)
    .join(", ");
  return [
    `name=${JSON.stringify(status.name)}`,
    ...(status.lifecycle === "running" ? [`steerTarget=${JSON.stringify(status.id)} (use as subagent_steer.target)`] : []),
    `lifecycle=${status.lifecycle}`,
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

  return {
    id: agent.id,
    name: agent.name,
    ...(agent.agent ? { agent: agent.agent } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    sessionFile: agent.sessionFile,
    surface: agent.surface,
    lifecycle,
    paneState: probe.paneState,
    doneFileExists: probe.doneFileExists,
    elapsedSeconds: Math.max(0, Math.floor((probe.now - agent.startTime) / 1000)),
    processes: probe.processes,
  };
}
