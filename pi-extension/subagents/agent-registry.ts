import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "package" | "global" | "my-pi" | "project";
export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  cwd?: string;
  body?: string;
  source: AgentSource;
  filePath: string;
  fileHash: string;
}
export interface AgentDiscovery {
  agents: AgentDefinition[];
  projectAgentsDir: string | null;
}
export interface DiscoveryOptions {
  cwd: string;
  scope?: AgentScope;
  home?: string;
  packageAgentsDir?: string;
}

function isDirectory(value: string): boolean {
  try { return statSync(value).isDirectory(); } catch { return false; }
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseAgentFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, body: content };
  const document = parseDocument(match[1]);
  if (document.errors.length) throw document.errors[0];
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent frontmatter must be a mapping");
  return { frontmatter: value as Record<string, unknown>, body: content.slice(match[0].length) };
}

function loadDirectory(dir: string, source: AgentSource): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter(file => file.endsWith(".md")).sort(); } catch { return []; }
  const result: AgentDefinition[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    let parsed: { frontmatter: Record<string, unknown>; body: string };
    let content: string;
    try { content = readFileSync(filePath, "utf8"); parsed = parseAgentFrontmatter(content); } catch { continue; }
    const fm = parsed.frontmatter;
    const name = optionalString(fm.name);
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") continue;
    result.push({
      name,
      description: optionalString(fm.description),
      model: optionalString(fm.model),
      tools: optionalString(fm.tools),
      skills: optionalString(fm.skill) ?? optionalString(fm.skills),
      thinking: optionalString(fm.thinking),
      denyTools: optionalString(fm["deny-tools"]),
      spawning: typeof fm.spawning === "boolean" ? fm.spawning : undefined,
      autoExit: typeof fm["auto-exit"] === "boolean" ? fm["auto-exit"] : undefined,
      cwd: optionalString(fm.cwd),
      body: parsed.body.trim() || undefined,
      source,
      filePath,
      fileHash: createHash("sha256").update(content).digest("hex"),
    });
  }
  return result;
}

export function discoverAgents(options: DiscoveryOptions): AgentDiscovery {
  const home = options.home ?? homedir();
  const scope = options.scope ?? "both";
  const packageDir = options.packageAgentsDir ?? join(dirname(fileURLToPath(import.meta.url)), "../../agents");
  const cwd = resolve(options.cwd);
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const roots: Array<{ dir: string; source: AgentSource }> = [];
  if (scope !== "project") roots.push(
    { dir: packageDir, source: "package" },
    { dir: join(home, ".pi", "agent", "agents"), source: "global" },
    { dir: join(home, ".my-pi", "agents"), source: "my-pi" },
  );
  if (scope !== "user" && projectAgentsDir) roots.push({ dir: projectAgentsDir, source: "project" });
  const byName = new Map<string, AgentDefinition>();
  for (const root of roots) for (const definition of loadDirectory(root.dir, root.source)) byName.set(definition.name, definition);
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), projectAgentsDir };
}

export function findAgent(discovery: AgentDiscovery, name: string): AgentDefinition | undefined {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return undefined;
  return discovery.agents.find(agent => agent.name === name);
}
