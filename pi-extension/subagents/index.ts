import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  isMuxAvailable,
  isTabTitleSupported,
  muxSetupHint,
  getMuxBackend,
  createSurface,
  sendCommand,
  closeSurface,
  getSurfaceState,
  probeSurfaceSubagent,
  shellEscape,
  prepareForSubagents,
  renameCurrentPane,
  renameCurrentTab,
  renameWorkspace,
} from "./cmux.ts";
import {
  buildCompletionInstructions,
  buildParentCompletionHandoffInstructions,
  buildResumeFollowupMessage,
} from "./prompt.ts";
import {
  SessionMessagingRegistry,
  formatIncomingSteer,
  readRecordedParent,
} from "./session-messaging.ts";
import { autoExitEnv, completionTools, resumeAutoExit, wrapChildCommand } from "./launch.ts";
import { discoverAgents, findAgent, type AgentDefinition, type AgentScope } from "./agent-registry.ts";
import {
  prepareModelChoice,
  prepareRuntimeModelReplacement,
  type CategoryChoice,
  type ModelCategory,
} from "./model-categories.ts";
import {
  findRuntimeModelRejection,
  formatRuntimeModelRejection,
  startupUnsupportedFailure,
} from "./runtime-model-errors.ts";
import { completionFromEntries, getSettledCompletion, readCompletion, type Completion, type CompletionStatus } from "./lifecycle.ts";
import {
  formatSubagentStatus,
  inspectSubagentStatus,
  listChildPiProcesses,
  readSubagentPresence,
  type PaneState,
} from "./status.ts";
import {
  getEntryCount,
  getNewEntries,
  readCompletionSummary,
  precreateChildSessionFile,
  buildSubagentChildManifestData,
} from "./session.ts";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Fork the current session — sub-agent gets full conversation context. Use for iterate/bugfix patterns.",
    }),
  ),
});

type AgentDefaults = AgentDefinition;

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set(["subagent", "subagents_list", "subagent_resume"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function loadAgentDefaults(agentName: string, cwd: string, scope: AgentScope = "both"): AgentDefaults | null {
  return findAgent(discoverAgents({ cwd, scope }), agentName) ?? null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
  if (kind === "tab-title") {
    return {
      content: [
        { type: "text" as const, text: `Terminal multiplexer not available. ${muxSetupHint()}` },
      ],
      details: { error: "mux not available" },
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the artifact directory path for the current session.
 * Same convention as the write_artifact tool:
 *   ~/.pi/history/<project>/artifacts/<session-id>/
 */
function getArtifactDir(cwd: string, sessionId: string): string {
  const project = basename(cwd);
  return join(homedir(), ".pi", "history", project, "artifacts", sessionId);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

/**
 * Try to find and measure a specific session file, or discover
 * the right one from new files in the session directory.
 *
 * When `trackedFile` is provided, measures that file directly.
 * Otherwise scans for new files not in `existingFiles` or `excludeFiles`.
 *
 * Returns { file, entries, bytes } — `file` is the path that was measured,
 * so callers can lock onto it for subsequent calls.
 */
/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  status?: CompletionStatus;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  /** Stable parent-side launch ID. */
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  /** Pi session ID in the child session header. */
  sessionId?: string;
  sessionFile: string;
  doneFile: string;
  lineageData: ReturnType<typeof buildSubagentChildManifestData>;
  autoExit?: boolean;
  entryCountBeforeResume?: number;
  launchEntryOffset?: number;
  pinnedCategory?: ModelCategory;
  pinnedChoice?: CategoryChoice;
  pinnedModel?: string;
  pinnedThinking?: string;
  definitionFile?: string;
  definitionHash?: string;
  runtimeUnsupported?: { errorMessage: string; model?: string };
  entries?: number;
  bytes?: number;
  forkCleanupFile?: string;
  abortController?: AbortController;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();
interface LaunchPreflight {
  params?: typeof SubagentParams.static;
  definition?: AgentDefinition;
  need?: any;
  category?: ModelCategory;
  choice?: CategoryChoice;
}

async function resolveLaunchModel(params: typeof SubagentParams.static, ctx: any, signal?: AbortSignal): Promise<LaunchPreflight> {
  const discoveryCwd = resolve(ctx.cwd, params.cwd ?? ".");
  const definition = params.agent ? loadAgentDefaults(params.agent, discoveryCwd) : null;
  if (params.agent && !definition) throw new Error(`Unknown agent: "${params.agent}".`);
  const requested = params.model ?? definition?.model;
  const resolution = await prepareModelChoice(requested, definition?.thinking, {
    registry: ctx.modelRegistry,
    ui: ctx.hasUI ? ctx.ui : undefined,
    hasUI: ctx.hasUI,
    signal,
  });
  if (resolution.kind !== "resolved") return { need: resolution, definition: definition ?? undefined };
  if (signal?.aborted) return { need: { kind: "cancelled", category: resolution.category, request: "Model choice cancelled." }, definition: definition ?? undefined };
  const model = resolution.provider ? `${resolution.provider}/${resolution.model}` : resolution.model;
  return {
    params: Object.assign({}, params, { model: model || undefined, _resolvedThinking: resolution.thinking }),
    definition: definition ?? undefined,
    category: resolution.category,
    choice: resolution.configuredChoice ?? (resolution.category && resolution.provider
      ? { provider: resolution.provider, model: resolution.model, ...(resolution.thinking ? { thinking: resolution.thinking } : {}) }
      : undefined),
  };
}

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatSubagentLabel(name: string, agent?: string): string {
  if (!agent || agent === name) return name;
  return `${name} [${agent}]`;
}

function hasVerifiedRunningPi(agent: { surface: string; sessionFile?: string }): boolean {
  if (!agent.sessionFile) return false;
  try {
    const muxProbe = probeSurfaceSubagent(agent.surface, agent.sessionFile);
    if (muxProbe) {
      return muxProbe.paneState === "present" && muxProbe.processes.length > 0;
    }
    return getSurfaceState(agent.surface) === "present" && listChildPiProcesses(agent.sessionFile).length > 0;
  } catch {
    return false;
  }
}

function buildPropagatedEnvPrefixParts(): string[] {
  const envNames = ["PTC_ALLOW_UNSANDBOXED_SUBPROCESS", "PTC_USE_DOCKER"];
  return envNames
    .map((name) => {
      const value = process.env[name];
      return value ? `${name}=${shellEscape(value)}` : null;
    })
    .filter((part): part is string => part !== null);
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 * When width is very narrow, right is also truncated to fit.
 */
function borderLine(left: string, right: string, width: number): string {
  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  // Truncate right side first if it alone exceeds content width
  const truncRight = visibleWidth(right) > contentWidth ? truncateToWidth(right, contentWidth) : right;
  const rightVis = visibleWidth(truncRight);
  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${truncRight}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          const count = runningSubagents.size;
          const title = "Subagents";
          const info = `${count} running`;

          const lines: string[] = [borderTop(title, info, width)];

          for (const [_id, agent] of runningSubagents) {
            const elapsed = formatElapsedMMSS(agent.startTime);
            const left = ` ${elapsed}  ${agent.name} `;
            const right =
              agent.entries != null && agent.bytes != null
                ? ` ${agent.entries} msgs (${formatBytes(agent.bytes)}) `
                : " starting… ";

            lines.push(borderLine(left, right, width));
          }

          lines.push(borderBottom(width));
          return lines;
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string }; cwd: string },
  options?: { surface?: string; definition?: AgentDefinition; category?: ModelCategory; choice?: CategoryChoice },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const startTimestamp = new Date(startTime).toISOString();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = options?.definition ?? null;
  if (params.agent && !agentDefs) throw new Error(`Unknown agent: "${params.agent}".`);
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = (params as any)._resolvedThinking ?? agentDefs?.thinking;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");

  const sessionDir = dirname(sessionFile);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = startTimestamp.replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
  const subagentDoneFile = join(sessionDir, `${timestamp}_${uuid}.done`);
  const displayName = formatSubagentLabel(params.name, params.agent);

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // Persist the actual child cwd in the precreated header and force the pane command
  // to start there so the durable header matches runtime reality.
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const effectiveCwd = rawCwd ? (isAbsolute(rawCwd) ? rawCwd : resolve(ctx.cwd, rawCwd)) : ctx.cwd;

  precreateChildSessionFile(subagentSessionFile, {
    sessionId: uuid,
    timestamp: startTimestamp,
    cwd: effectiveCwd,
    parentSession: sessionFile,
  });

  // Build the task message
  // When forking, the sub-agent already has the full conversation context.
  // Only send the user's task as a clean message — no wrapper instructions
  // that would confuse the agent into thinking it needs to restart.
  const modeHint = "Complete your task autonomously, then return control to the parent agent.";
  const completionInstructions = buildCompletionInstructions({ autoExit: agentDefs?.autoExit });
  const denySet = resolveDenyTools(agentDefs);
  const agentType = params.agent ?? params.name;
  const tabTitleInstruction = denySet.has("set_tab_title") || !isTabTitleSupported()
    ? ""
    : `As your FIRST action, set your title using set_tab_title. ` +
      `The title MUST start with [${agentType}] followed by a short description of your current task. ` +
      `Example: "[${agentType}] Analyzing auth module". Keep it concise.`;
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const roleBlock = identity ? `\n\n${identity}` : "";
  const fullTask = params.fork
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}\n\n${completionInstructions}`;

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  // For fork mode, create a clean copy of the session that excludes
  // the "Use subagent..." meta-message and tool call that triggered this.
  // The forked session sees only the original conversation + the user's actual task.
  let forkCleanupFile: string | undefined;
  let launchEntryOffset = 1;
  if (params.fork) {
    const raw = readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    // Walk backwards to find the last user message (the meta-instruction)
    // and truncate everything from there onwards
    let truncateAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "user") {
          truncateAt = i;
          break;
        }
      } catch {}
    }

    const cleanLines = lines.slice(0, truncateAt);
    launchEntryOffset = cleanLines.length;
    forkCleanupFile = join(tmpdir(), `pi-fork-clean-${Date.now()}.jsonl`);
    writeFileSync(forkCleanupFile, cleanLines.join("\n") + "\n", "utf8");
    parts.push("--fork", shellEscape(forkCleanupFile));
  }

  const extensionDir = dirname(new URL(import.meta.url).pathname);
  const subagentDonePath = join(extensionDir, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));
  if (options?.category) {
    parts.push("-e", shellEscape(join(extensionDir, "runtime-model-observer.ts")));
  }

  if (effectiveModel) parts.push("--model", shellEscape(effectiveModel));
  if (effectiveThinking) parts.push("--thinking", shellEscape(effectiveThinking));

  const tools = completionTools(effectiveTools);
  if (tools !== undefined) parts.push("--tools", shellEscape(tools));

  if (effectiveSkills) {
    for (const skill of effectiveSkills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      parts.push(shellEscape(`/skill:${skill}`));
    }
  }

  // Build env prefix: denied tools + subagent identity.
  // Multiplexer-created panes can inherit server environment captured before
  // the parent Pi started. Propagate extension-critical values explicitly.
  const envParts: string[] = buildPropagatedEnvPrefixParts();
  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  envParts.push(`PI_SUBAGENT_PARENT_SESSION=${shellEscape(sessionFile)}`);
  envParts.push(`PI_SUBAGENT_SUMMARY_FILE=${shellEscape(`${subagentDoneFile}.summary`)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  envParts.push(autoExitEnv(agentDefs?.autoExit === true));
  const envPrefix = envParts.join(" ") + " ";

  // Pass task to the sub-agent.
  // For fork mode, pass as a plain quoted argument — the forked session already
  // has the full conversation context, so the message arrives as if the user typed it.
  // For non-fork mode, write to an artifact file and pass via @file to handle
  // long task descriptions with role/instructions safely.
  if (params.fork) {
    parts.push(shellEscape(fullTask));
  } else {
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.cwd, sessionId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    parts.push(`@${artifactPath}`);
  }

  const cdPrefix = `cd ${shellEscape(effectiveCwd)} && `;

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = wrapChildCommand(piCommand, subagentDoneFile);

  // Zellij and tmux launch the command as part of pane creation. This avoids a
  // timing race where typed commands can land in the wrong shell or pane.
  const surfacePreCreated = !!options?.surface;
  const muxBackend = getMuxBackend();
  if ((muxBackend === "zellij" || muxBackend === "tmux") && !process.env.PI_SUBAGENT_NAME) {
    prepareForSubagents(`π ${displayName}`);
  }
  const launchesDirectly = muxBackend === "zellij" || muxBackend === "tmux";
  const surface =
    options?.surface ??
    (launchesDirectly
      ? createSurface(displayName, command, effectiveCwd)
      : createSurface(displayName, undefined, effectiveCwd));
  if (surfacePreCreated || !launchesDirectly) {
    sendCommand(surface, command);
  }

  const running: RunningSubagent = {
    id,
    name: displayName,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionId: uuid,
    sessionFile: subagentSessionFile,
    doneFile: subagentDoneFile,
    lineageData: buildSubagentChildManifestData({
      id,
      name: displayName,
      agent: params.agent,
      startTimestamp,
      childSessionPath: subagentSessionFile,
      parentSessionPath: sessionFile,
    }),
    autoExit: agentDefs?.autoExit === true,
    forkCleanupFile,
    launchEntryOffset,
    pinnedCategory: options?.category,
    pinnedChoice: options?.choice,
    pinnedModel: effectiveModel,
    pinnedThinking: effectiveThinking,
    definitionFile: agentDefs?.filePath,
    definitionHash: agentDefs?.fileHash,
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface and fork file,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile, doneFile, forkCleanupFile } = running;

  let fallbackCompletion: Completion | undefined;
  let settledKey: string | undefined;
  let settledSince = 0;
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = () => { clearTimeout(timer); reject(new Error("Aborted while waiting for subagent to finish")); };
      signal.addEventListener("abort", onAbort, { once: true });
      const finish = (code: number) => { signal.removeEventListener("abort", onAbort); resolve(code); };
      const tick = () => {
        if (signal.aborted) {
          reject(new Error("Aborted while waiting for subagent to finish"));
          return;
        }

        // Update entries/bytes for widget display
        try {
          if (existsSync(sessionFile)) {
            const stat = statSync(sessionFile);
            const raw = readFileSync(sessionFile, "utf8");
            running.entries = raw.split("\n").filter((l) => l.trim()).length;
            running.bytes = stat.size;
          }
        } catch {}

        // Startup unsupported-model errors otherwise leave an interactive child idle.
        // Inspect only structured assistant errors from this launch, never arbitrary text.
        if (running.pinnedCategory && running.pinnedChoice && existsSync(sessionFile)) {
          try {
            const failure = startupUnsupportedFailure(
              getNewEntries(sessionFile, running.launchEntryOffset ?? 1),
              running.pinnedChoice,
            );
            if (failure) {
              running.runtimeUnsupported = failure;
              fallbackCompletion = { status: "failed", summary: failure.errorMessage };
              closeSurface(surface);
              finish(1);
              return;
            }
          } catch {}
        }

        try {
          if (existsSync(doneFile)) {
            const raw = readFileSync(doneFile, "utf8").trim();
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isNaN(parsed)) {
              finish(parsed);
              return;
            }
          }
        } catch {}

        // A settled unattended child must exit, including failures. Ignore
        // trailing metadata, but never use an old resume result or a mere stop
        // message while Pi still has retries/queued work. Allow graceful exit first.
        if (running.autoExit && existsSync(sessionFile)) {
          try {
            const settled = getSettledCompletion(getNewEntries(sessionFile, running.entryCountBeforeResume ?? 0));
            if (!settled) settledKey = undefined;
            else if (settled.key !== settledKey) {
              settledKey = settled.key;
              settledSince = Date.now();
            } else if (Date.now() - settledSince >= 3000) {
              closeSurface(surface);
              fallbackCompletion = settled.completion;
              finish(settled.completion.status === "failed" ? 1 : 0);
              return;
            }
          } catch { settledKey = undefined; }
        }

        timer = setTimeout(tick, 1000);
      };

      tick();
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    const newEntries = existsSync(sessionFile)
      ? getNewEntries(sessionFile, running.launchEntryOffset ?? running.entryCountBeforeResume ?? 0) : [];
    if (running.pinnedCategory && running.pinnedChoice && !running.runtimeUnsupported) {
      running.runtimeUnsupported = findRuntimeModelRejection(newEntries, running.pinnedChoice);
    }
    const legacySummary = readCompletionSummary(doneFile);
    const completion = completionFromEntries(newEntries,
      readCompletion(doneFile) ?? fallbackCompletion ??
      (legacySummary ? { status: "reported", summary: legacySummary } : undefined));
    const status = completion.status;
    const summary = exitCode !== 0
      ? `Process exited with code ${exitCode}.\n\n${completion.summary}`
      : completion.summary;

    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    try {
      unlinkSync(doneFile);
    } catch {}
    try {
      unlinkSync(`${doneFile}.summary`);
    } catch {}

    try {
      unlinkSync(`${doneFile}.summary.json`);
    } catch {}

    // Clean up temp fork file
    if (forkCleanupFile) {
      try {
        unlinkSync(forkCleanupFile);
      } catch {}
    }

    return { name, task, summary, sessionFile, exitCode, elapsed, status };
  } catch (err: any) {
    try {
      unlinkSync(`${doneFile}.summary.json`);
    } catch {}
    try {
      unlinkSync(doneFile);
    } catch {}
    try {
      unlinkSync(`${doneFile}.summary`);
    } catch {}
    if (forkCleanupFile) {
      try {
        unlinkSync(forkCleanupFile);
      } catch {}
    }
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  let lifecycleController = new AbortController();
  let sessionActive = false;
  let sessionMessaging: SessionMessagingRegistry | undefined;

  // Capture the UI context and bind a private endpoint to this exact runtime session.
  pi.on("session_start", async (_event, ctx) => {
    lifecycleController.abort();
    lifecycleController = new AbortController();
    sessionActive = true;
    latestCtx = ctx;
    await sessionMessaging?.close();
    const session = {
      id: ctx.sessionManager.getSessionId(),
      ...(ctx.sessionManager.getSessionFile() ? { path: ctx.sessionManager.getSessionFile() } : {}),
    };
    sessionMessaging = new SessionMessagingRegistry({
      session,
      parent: readRecordedParent(ctx.sessionManager.getHeader()),
      aliases: [process.env.PI_SUBAGENT_NAME, ctx.sessionManager.getSessionName()].filter((value): value is string => !!value),
      accept: async (message) => {
        await pi.sendUserMessage(formatIncomingSteer(message), {
          deliverAs: "steer",
          expandPromptTemplates: false,
        });
      },
    });
    await sessionMessaging.start();
  });

  // Clean up on session shutdown, including dialogs whose child is no longer tracked.
  pi.on("session_shutdown", async (_event, _ctx) => {
    sessionActive = false;
    lifecycleController.abort();
    await sessionMessaging?.close();
    sessionMessaging = undefined;
    latestCtx = null;
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        buildParentCompletionHandoffInstructions(),
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        buildParentCompletionHandoffInstructions(),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Subagent launch cancelled." }], details: { kind: "cancelled" }, isError: true };
        }
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Resolve category aliases once before creating any child state or pane.
        const preflight = await resolveLaunchModel(params, ctx, signal);
        if (!preflight.params || signal?.aborted) {
          const need = preflight.need ?? { kind: "cancelled", request: "Model choice cancelled." };
          return {
            content: [{ type: "text", text: need.kind === "cancelled" ? "Model choice cancelled; no subagent launched." : need.request }],
            details: need,
            isError: true,
          };
        }
        const running = await launchSubagent(preflight.params, ctx, {
          definition: preflight.definition,
          category: preflight.category,
          choice: preflight.choice,
        });
        pi.appendEntry("subagent_child", {
          ...running.lineageData,
          modelCategory: running.pinnedCategory,
          model: running.pinnedModel,
          thinking: running.pinnedThinking,
          definitionFile: running.definitionFile,
          definitionHash: running.definitionHash,
        });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh when first agent launches
        startWidgetRefresh();

        const sessionSignal = lifecycleController.signal;
        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then(async (result) => {
            updateWidget(); // reflect removal from Map immediately
            if (!sessionActive || sessionSignal.aborted) return;
            let replacement: any;
            if (running.runtimeUnsupported && running.pinnedCategory && running.pinnedChoice) {
              try {
                replacement = await prepareRuntimeModelReplacement(
                  running.pinnedCategory,
                  running.pinnedChoice,
                  running.runtimeUnsupported.model ?? running.pinnedModel,
                  {
                    registry: ctx.modelRegistry,
                    ui: ctx.hasUI ? ctx.ui : undefined,
                    hasUI: ctx.hasUI,
                    signal: sessionSignal,
                  },
                );
              } catch (error: any) {
                replacement = { kind: "conflict", request: error?.message ?? String(error) };
              }
              if (!sessionActive || sessionSignal.aborted) return;
              pi.appendEntry("subagent_model_rejection", {
                id: running.id,
                status: "stopped",
                category: running.pinnedCategory,
                failedModel: running.runtimeUnsupported.model ?? running.pinnedModel,
                replacement,
              });
            }
            if (!sessionActive || sessionSignal.aborted) return;
            const sessionRef = result.sessionFile
              ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
              : "";
            const outcome = result.status ?? (result.exitCode !== 0 ? "failed" : "reported");
            const summary = running.runtimeUnsupported && running.pinnedCategory
              ? formatRuntimeModelRejection(running.pinnedCategory, result.summary, replacement)
              : result.summary;
            const content = `Sub-agent "${running.name}" ${outcome} (${formatElapsed(result.elapsed)}).\n\n${summary}${sessionRef}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  status: result.status,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  modelCategory: running.pinnedCategory,
                  model: running.pinnedModel,
                  thinking: running.pinnedThinking,
                  replacement,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            if (!sessionActive || sessionSignal.aborted) return;
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${running.name}" launched and is being tracked. ` +
                "Use subagent_status before claiming its Pi process is live. " +
                "Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. " +
                buildParentCompletionHandoffInstructions(),
            },
          ],
          details: {
            id: running.id,
            name: running.name,
            task: params.task,
            agent: params.agent,
            sessionId: running.sessionId,
            sessionFile: running.sessionFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
        let text =
          "▸ " + theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) + agent + cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        const task = args.task ?? "";
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  function getSubagentStatusReport(scope: "children" | "all" = "children") {
    if (scope === "all") {
      const sessions = sessionMessaging?.list() ?? [];
      return {
        summary: sessions.length === 0
          ? "No live sessions are registered for cross-session steering."
          : sessions.map((route) => [
              `sessionId=${JSON.stringify(route.session.id)}`,
              ...(route.session.path ? [`sessionFile=${JSON.stringify(route.session.path)}`] : []),
              ...(route.aliases.length ? [`aliases=${JSON.stringify(route.aliases)}`] : []),
              `pid=${route.pid}`,
            ].join("; ")).join("\n"),
        details: { scope: "all", sessions },
      };
    }
    const statuses = [...runningSubagents.values()].map((agent) => {
      let processes: ReturnType<typeof listChildPiProcesses> = [];
      let paneState: PaneState = "unknown";
      try {
        const muxProbe = probeSurfaceSubagent(agent.surface, agent.sessionFile);
        if (muxProbe) {
          processes = muxProbe.processes;
          paneState = muxProbe.paneState;
        } else {
          processes = listChildPiProcesses(agent.sessionFile);
          paneState = getSurfaceState(agent.surface);
        }
      } catch {
        // Probe failures remain unknown. They never prove that the Pi process is dead.
      }
      return inspectSubagentStatus(agent, {
        presence: readSubagentPresence(agent.sessionId),
        doneFileExists: existsSync(agent.doneFile),
        paneState,
        processes,
        now: Date.now(),
      });
    });
    const summary =
      statuses.length === 0
        ? "No subagents are tracked by this parent session."
        : statuses.map(formatSubagentStatus).join("\n");

    return {
      summary,
      details: {
        subagents: statuses.map((status) => ({
          ...status,
          processes: status.processes.map(({ command: _command, ...process }) => process),
        })),
      },
    };
  }

  pi.registerCommand("subagent_status", {
    description: "Show verified subagent status without an AI turn",
    handler: async (_args, ctx) => {
      ctx.ui.notify(getSubagentStatusReport().summary, "info");
    },
  });

  // ── subagent_status tool ──
  if (shouldRegister("subagent_status"))
    pi.registerTool({
      name: "subagent_status",
      label: "Subagent Status",
      description:
        "Report this session's tracked children, or discover every locally registered session with scope=all. " +
        "Tracked-child activity is processing, idle, or unknown from fresh matching presence telemetry. " +
        "For tracked children, lifecycle=running means the Pi process is alive, not necessarily working. " +
        "Use exact registered session IDs or paths from scope=all for cross-session steering.",
      promptSnippet:
        "Use subagent_status with the default children scope before claiming a tracked child is live. " +
        "Treat only lifecycle=running as proof that its Pi process is live; idle means no active agent run and unknown is not evidence of work. " +
        "Use scope=all to discover registered local sessions for cross-session steering. " +
        "Do not infer child liveness from a launch result, visible pane, or detached process.",
      parameters: Type.Object({
        scope: Type.Optional(Type.Union([Type.Literal("children"), Type.Literal("all")], {
          description: "Use all to discover every locally registered live session; default is this session's tracked children",
        })),
      }),
      async execute(_toolCallId, params) {
        const { summary, details } = getSubagentStatusReport(params.scope ?? "children");
        return {
          content: [{ type: "text", text: summary }],
          details,
        };
      },
    });

  // ── subagent_steer tool ──
  if (shouldRegister("subagent_steer"))
    pi.registerTool({
      name: "subagent_steer",
      label: "Steer Subagent",
      description:
        "Send a new instruction to an explicitly identified registered local Pi session. " +
        "Any local session, including a nested caller, may steer. This does not type into a terminal, resume, or spawn. " +
        "Use a caller-local launch id/name or an exact registered session id/path; scope=all status discovers registered sessions.",
      promptSnippet:
        "Send a new instruction to an explicitly identified registered local Pi session. " +
        "This uses Pi message delivery without terminal input, resume, or spawn. " +
        "Use subagent_status scope=all for discovery and prefer an exact session id or path.",
      parameters: Type.Object({
        target: Type.String({
          description: "Caller-local launch id/name, or registered Pi session id/path"
        }),
        message: Type.String({
          description: "Instruction to deliver to the active subagent",
        }),
      }),

      async execute(_toolCallId, params) {
        try {
          if (!sessionMessaging) throw new Error("This session has no active messaging endpoint.");
          const local = [...runningSubagents.values()].filter((agent) => agent.id === params.target || agent.name === params.target);
          if (local.length > 1) throw new Error(`Target "${params.target}" is ambiguous; use an exact launch or session ID.`);
          const target = local[0]?.sessionId ?? local[0]?.sessionFile ?? params.target;
          const route = await sessionMessaging.send(target, params.message);
          return {
            content: [{ type: "text", text: `Steering message accepted by session "${route.session.id}".` }],
            details: {
              sessionId: route.session.id,
              sessionFile: route.session.path,
              instance: route.instance,
              status: "accepted",
            },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Failed to steer subagent: ${err?.message ?? String(err)}` }],
            details: { error: err?.message ?? String(err) },
            isError: true,
          };
        }
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/, version-controlled ~/.my-pi/agents/, and global ~/.pi/agent/agents/. " +
        "Project-local agents override user/global/package agents with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/, version-controlled ~/.my-pi/agents/, and global ~/.pi/agent/agents/. " +
        "Project-local agents override user/global/package agents with the same name.",
      parameters: Type.Object({
        cwd: Type.Optional(Type.String({ description: "Discovery base directory" })),
        scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
      }),

      async execute(_id, params, _signal, _update, ctx) {
        const discovery = discoverAgents({ cwd: resolve(ctx.cwd, params.cwd ?? "."), scope: params.scope ?? "both" });
        const agents = discovery.agents;
        if (agents.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [], projectAgentsDir: discovery.projectAgentsDir },
          };
        }

        const list = agents;
        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list, projectAgentsDir: discovery.projectAgentsDir },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });

  // ── set_tab_title tool ──
  if (shouldRegister("set_tab_title") && isTabTitleSupported())
    pi.registerTool({
      name: "set_tab_title",
      label: "Set Tab Title",
      description:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      promptSnippet:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      parameters: Type.Object({
        title: Type.String({
          description: "New tab title (also applied to workspace/session when supported)",
        }),
      }),

      async execute(_toolCallId, params) {
        if (!isMuxAvailable()) {
          return muxUnavailableResult("tab-title");
        }
        try {
          if (process.env.PI_SUBAGENT_NAME) {
            renameCurrentPane(params.title);
          } else {
            renameCurrentTab(params.title);
            renameWorkspace(params.title);
          }
          return {
            content: [{ type: "text", text: `Title set to: ${params.title}` }],
            details: { title: params.title },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Failed to set title: ${err?.message}` }],
            details: { error: err?.message },
          };
        }
      },
    });

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use only when a sub-agent was cancelled or needs follow-up work. Use subagent_steer when its session is still registered live.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use only when a sub-agent was cancelled or needs follow-up work. Use subagent_steer when its session is still registered live.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const displayName = formatSubagentLabel(name);
        const startTime = Date.now();

        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBeforeResume = getEntryCount(params.sessionPath);

        const doneFile = join(
          dirname(params.sessionPath),
          `resume-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.done`,
        );

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(
          dirname(new URL(import.meta.url).pathname),
          "subagent-done.ts",
        );
        parts.push("-e", shellEscape(subagentDonePath));

        const autoExit = resumeAutoExit(params.message);
        let cleanupMsgFile: string | undefined;
        if (autoExit && params.message) {
          const msgFile = join(tmpdir(), `subagent-resume-${Date.now()}.md`);
          writeFileSync(msgFile, buildResumeFollowupMessage(params.message), "utf8");
          cleanupMsgFile = msgFile;
          parts.push(`@${msgFile}`);
        }

        const resumeEnvParts = buildPropagatedEnvPrefixParts();
        resumeEnvParts.push(autoExitEnv(autoExit));
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_PARENT_SESSION=${shellEscape(ctx.sessionManager.getSessionFile() ?? "")}`);
        resumeEnvParts.push(`PI_SUBAGENT_SUMMARY_FILE=${shellEscape(`${doneFile}.summary`)}`);
        const envPrefix = resumeEnvParts.join(" ");
        const commandPrefix = envPrefix ? `${envPrefix} ` : "";
        const command = wrapChildCommand(`${commandPrefix}${parts.join(" ")}`, doneFile, cleanupMsgFile);
        let resumeCwd = ctx.cwd;
        try {
          const header = JSON.parse(
            readFileSync(params.sessionPath, "utf8").split("\n").find((line) => line.trim()) ?? "{}",
          );
          if (typeof header.cwd === "string" && header.cwd.startsWith("/")) resumeCwd = header.cwd;
        } catch {}
        const muxBackend = getMuxBackend();
        const launchesDirectly = muxBackend === "zellij" || muxBackend === "tmux";
        const surface = launchesDirectly
          ? createSurface(displayName, command, resumeCwd)
          : createSurface(displayName, undefined, resumeCwd);
        if (!launchesDirectly) sendCommand(surface, command);

        // Register as a running subagent for widget tracking
        const id = Math.random().toString(16).slice(2, 10);
        const running: RunningSubagent = {
          id,
          name: displayName,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          doneFile,
          autoExit,
          entryCountBeforeResume,
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();
            const summary = result.summary;
            const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${displayName}" ${result.status ?? (result.exitCode !== 0 ? "failed" : "reported")}.\n\n${summary}${sessionRef}`,
                display: true,
                details: {
                  name: displayName,
                  task: params.message ?? "resumed session",
                  status: result.status,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: { id, name: displayName, sessionPath: params.sessionPath, status: "started" },
        };
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args?.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName, ctx.cwd);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn =
          exitCode === 0
            ? (text: string) => theme.bg("toolSuccessBg", text)
            : (text: string) => theme.bg("toolErrorBg", text);
        const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      if (isTabTitleSupported()) {
        try {
          const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(dirname(new URL(import.meta.url).pathname), "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}
// test
