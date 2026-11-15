import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MODEL_CATEGORIES = ["fast", "balanced", "deep"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelCategory = typeof MODEL_CATEGORIES[number];
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export interface CategoryChoice { provider: string; model: string; thinking?: ThinkingLevel }
interface Profile { version: 1; categories: Partial<Record<ModelCategory, CategoryChoice>> }
interface RegistryModel { provider: string; id: string }
export interface LocalModelRegistry {
  getAll(): RegistryModel[];
  getAvailable(): RegistryModel[];
  find(provider: string, model: string): RegistryModel | undefined;
  hasConfiguredAuth?(model: RegistryModel): boolean;
}
export type ModelResolution =
  | { kind: "resolved"; category?: ModelCategory; provider?: string; model: string; thinking?: ThinkingLevel; configuredChoice?: CategoryChoice }
  | { kind: "needs_model_choice"; category: ModelCategory; request: string; reason: "unconfigured" | "missing_model"; configuredChoice?: CategoryChoice }
  | { kind: "auth_error"; category: ModelCategory; request: string; reason: "missing_auth"; configuredChoice?: CategoryChoice };
export type PreparedModelChoice = ModelResolution | { kind: "cancelled"; category: ModelCategory; request: string };

export interface ModelChoiceUI { select(title: string, options: string[], settings?: { signal?: AbortSignal }): Promise<string | undefined> }
export interface PrepareModelChoiceOptions {
  registry: LocalModelRegistry;
  ui?: ModelChoiceUI;
  hasUI: boolean;
  signal?: AbortSignal;
  file?: string;
}

export function modelCategoriesFile(home = homedir()): string {
  return join(home, ".pi", "agent", "model-categories.json");
}
export function isModelCategory(value?: string): value is ModelCategory {
  return !!value && (MODEL_CATEGORIES as readonly string[]).includes(value);
}
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function validChoice(value: unknown): value is CategoryChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return exactKeys(v, ["provider", "model", "thinking"]) &&
    typeof v.provider === "string" && !!v.provider.trim() && v.provider === v.provider.trim() &&
    typeof v.model === "string" && !!v.model.trim() && v.model === v.model.trim() &&
    (v.thinking === undefined || isThinkingLevel(v.thinking));
}
function readProfile(file: string): Profile | undefined {
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`Model categories config is corrupt: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model categories config has an unsupported schema or version");
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["version", "categories"]) || root.version !== 1 || !root.categories || typeof root.categories !== "object" || Array.isArray(root.categories)) {
    throw new Error("Model categories config has an unsupported schema or version");
  }
  for (const [name, choice] of Object.entries(root.categories as Record<string, unknown>)) {
    if (!isModelCategory(name) || !validChoice(choice)) throw new Error(`Model categories config has an invalid category: ${name}`);
  }
  return value as Profile;
}
export function getCategoryChoice(category: ModelCategory, file = modelCategoriesFile()): CategoryChoice | undefined {
  return readProfile(file)?.categories[category];
}
export function resolveModelChoice(model: string | undefined, thinking: string | undefined, options: { registry: LocalModelRegistry; file?: string }): ModelResolution {
  if (thinking !== undefined && !isThinkingLevel(thinking)) throw new Error(`Invalid thinking level: ${thinking}`);
  if (!isModelCategory(model)) return { kind: "resolved", model: model ?? "", thinking } as ModelResolution;
  const choice = readProfile(options.file ?? modelCategoriesFile())?.categories[model];
  if (!choice) return { kind: "needs_model_choice", category: model, reason: "unconfigured", request: `Choose a local model for the '${model}' category.` };
  const known = options.registry.find(choice.provider, choice.model);
  if (!known) return { kind: "needs_model_choice", category: model, reason: "missing_model", configuredChoice: choice, request: `The model configured for '${model}' is not installed; choose a replacement.` };
  const available = options.registry.getAvailable().some(item => item.provider === choice.provider && item.id === choice.model);
  if (!available || options.registry.hasConfiguredAuth?.(known) === false) {
    return { kind: "auth_error", category: model, reason: "missing_auth", configuredChoice: choice, request: `Authentication is not configured for ${choice.provider}/${choice.model}. Log in before launching '${model}'.` };
  }
  return { kind: "resolved", category: model, provider: choice.provider, model: choice.model, thinking: choice.thinking ?? thinking as ThinkingLevel | undefined, configuredChoice: choice };
}
function equalChoice(a: CategoryChoice | undefined, b: CategoryChoice | undefined): boolean {
  return a?.provider === b?.provider && a?.model === b?.model && a?.thinking === b?.thinking;
}
export function saveCategoryChoice(category: ModelCategory, choice: CategoryChoice, options: { file?: string; expected?: CategoryChoice } = {}): void {
  if (!validChoice(choice)) throw new Error("Invalid model category choice");
  const file = options.file ?? modelCategoriesFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error: any) { if (error?.code === "EEXIST") throw new Error("Model categories update conflict: lock is busy"); throw error; }
  let temporary: string | undefined;
  try {
    const profile = readProfile(file) ?? { version: 1 as const, categories: {} };
    if (!equalChoice(profile.categories[category], options.expected)) throw new Error(`Model categories update conflict for '${category}'`);
    profile.categories[category] = choice;
    temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    temporary = undefined;
  } finally {
    if (temporary) rmSync(temporary, { force: true });
    closeSync(fd!);
    rmSync(lock, { force: true });
  }
}

let promptQueue: Promise<void> = Promise.resolve();
function enqueuePrompt<T>(work: () => Promise<T>): Promise<T> {
  const result = promptQueue.catch(() => {}).then(work);
  promptQueue = result.then(() => {}, () => {});
  return result;
}
function availableOptions(registry: LocalModelRegistry): string[] {
  return [...new Set(registry.getAvailable().map(item => `${item.provider}/${item.id}`))].filter(value => value.split("/").every(Boolean)).sort();
}

/** Release the serialized prompt queue even if a UI implementation ignores AbortSignal. */
async function selectWithAbort(ui: ModelChoiceUI, title: string, values: string[], signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    if (!signal) return;
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const selected = Promise.resolve().then(() => ui.select(title, values, { signal }));
    return signal ? await Promise.race([selected, aborted]) : await selected;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Shared launch preflight. Policy is deliberately re-read inside the prompt queue. */
export async function prepareModelChoice(model: string | undefined, thinking: string | undefined, options: PrepareModelChoiceOptions): Promise<PreparedModelChoice> {
  if (options.signal?.aborted) return { kind: "cancelled", category: isModelCategory(model) ? model : "balanced", request: "Model choice cancelled." };
  const initial = resolveModelChoice(model, thinking, options);
  if (initial.kind !== "needs_model_choice" || !options.hasUI || !options.ui) return initial;
  return enqueuePrompt(async () => {
    if (options.signal?.aborted) return { kind: "cancelled", category: initial.category, request: "Model choice cancelled." };
    const current = resolveModelChoice(model, thinking, options);
    if (current.kind !== "needs_model_choice") return current;
    const offered = availableOptions(options.registry);
    if (offered.length === 0) return { kind: "auth_error", category: current.category, reason: "missing_auth", configuredChoice: current.configuredChoice, request: `No authenticated local models are available for '${current.category}'.` };
    const selected = await selectWithAbort(options.ui!, `Choose replacement for '${current.category}'`, offered, options.signal);
    if (options.signal?.aborted || selected === undefined) return { kind: "cancelled", category: current.category, request: "Model choice cancelled." };
    if (!offered.includes(selected)) throw new Error("Selected model was not one of the offered options");
    const slash = selected.indexOf("/");
    const preservedThinking = current.configuredChoice?.thinking ?? (isThinkingLevel(thinking) ? thinking : undefined);
    let selectedThinking = preservedThinking;
    if (!selectedThinking) {
      const offeredThinking = [...THINKING_LEVELS];
      const value = await selectWithAbort(options.ui!, `Choose thinking for '${current.category}'`, offeredThinking, options.signal);
      if (options.signal?.aborted || value === undefined) return { kind: "cancelled", category: current.category, request: "Model choice cancelled." };
      if (!isThinkingLevel(value)) throw new Error("Selected thinking level was not one of the offered options");
      selectedThinking = value;
    }
    const choice: CategoryChoice = { provider: selected.slice(0, slash), model: selected.slice(slash + 1), thinking: selectedThinking };
    if (options.signal?.aborted) return { kind: "cancelled", category: current.category, request: "Model choice cancelled." };
    saveCategoryChoice(current.category, choice, { file: options.file, expected: current.configuredChoice });
    return { kind: "resolved", category: current.category, provider: choice.provider, model: choice.model, thinking: choice.thinking, configuredChoice: choice };
  });
}

export async function prepareRuntimeModelReplacement(category: ModelCategory, expected: CategoryChoice, failedModel: string | undefined, options: PrepareModelChoiceOptions): Promise<PreparedModelChoice> {
  return enqueuePrompt(async () => {
    const current = getCategoryChoice(category, options.file ?? modelCategoriesFile());
    if (!equalChoice(current, expected)) {
      if (!current) throw new Error(`Model categories update conflict for '${category}'`);
      const known = options.registry.find(current.provider, current.model);
      const available = known && options.registry.getAvailable().some(item => item.provider === current.provider && item.id === current.model);
      if (!available) throw new Error(`Newer model mapping for '${category}' is not available`);
      return { kind: "resolved", category, provider: current.provider, model: current.model, thinking: current.thinking, configuredChoice: current };
    }
    if (!options.hasUI || !options.ui) return { kind: "needs_model_choice", category, reason: "missing_model", configuredChoice: expected, request: `The provider rejected ${failedModel ?? `${expected.provider}/${expected.model}`}; choose a replacement for '${category}'.` };
    if (options.signal?.aborted) return { kind: "cancelled", category, request: "Model choice cancelled." };
    const failed = failedModel ?? `${expected.provider}/${expected.model}`;
    const offered = availableOptions(options.registry).filter(value => value !== failed && value !== `${expected.provider}/${expected.model}`);
    if (!offered.length) return { kind: "auth_error", category, reason: "missing_auth", configuredChoice: expected, request: `No other authenticated local models are available for '${category}'.` };
    const selected = await selectWithAbort(options.ui, `Choose replacement for '${category}'`, offered, options.signal);
    if (options.signal?.aborted || selected === undefined) return { kind: "cancelled", category, request: "Model choice cancelled." };
    if (!offered.includes(selected)) throw new Error("Selected model was not one of the offered options");
    const slash = selected.indexOf("/");
    const choice: CategoryChoice = { provider: selected.slice(0, slash), model: selected.slice(slash + 1), ...(expected.thinking ? { thinking: expected.thinking } : {}) };
    saveCategoryChoice(category, choice, { file: options.file, expected });
    return { kind: "resolved", category, provider: choice.provider, model: choice.model, thinking: choice.thinking, configuredChoice: choice };
  });
}

export function isAuthoritativeUnsupportedModelError(message: { role?: string; stopReason?: string; errorMessage?: string; model?: string }): boolean {
  if (message.role !== "assistant" || message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
  const error = message.errorMessage;
  // Authentication, throttling, and transport failures never invalidate a model mapping,
  // even when a wrapper includes an unsupported-model token in the same error string.
  if (/(?:invalid[_ -]?api[_ -]?key|api[_ -]?key|access[_ -]?token|\btoken\b|bearer|oauth|auth(?:entication|orization)?|unauthori[sz]ed|forbidden|credential|log[ -]?in|\b401\b|\b403\b|rate[ _-]?limit|too many requests|\b429\b|quota|econn(?:reset|refused|aborted)|enotfound|eai_again|etimedout|dns|network|transport|socket|connection|timed?\s*out|\b(?:408|502|503|504)\b)/i.test(error)) return false;
  return /(?:the ['“][^'”]+['”] model is not supported when using|unsupported_model|model_not_supported|model_not_found)/i.test(error);
}
