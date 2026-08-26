export interface SteerableSubagent {
  id: string;
  name: string;
  surface: string;
  doneFile?: string;
}

export type SubagentSteerResult =
  | { agent: SteerableSubagent }
  | { error: string };

export function steerRunningSubagent(options: {
  running: Iterable<SteerableSubagent>;
  target: string;
  message: string;
  send: (surface: string, message: string) => void;
  isComplete?: (agent: SteerableSubagent) => boolean;
}): SubagentSteerResult {
  const target = options.target.trim();
  const message = options.message.trim();
  if (!message) return { error: "Steering message cannot be empty." };

  const matches = [...options.running].filter((agent) => agent.id === target || agent.name === target);
  if (matches.length === 0) {
    return { error: `No running subagent matches "${target}".` };
  }
  if (matches.length > 1) {
    return {
      error: `Multiple running subagents are named "${target}". Use an id: ${matches.map((agent) => agent.id).join(", ")}.`,
    };
  }

  const agent = matches[0];
  if (options.isComplete?.(agent)) {
    return { error: `Subagent "${agent.name}" has already completed.` };
  }

  options.send(agent.surface, message);
  return { agent };
}
