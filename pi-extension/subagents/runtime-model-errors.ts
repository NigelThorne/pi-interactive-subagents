import { getSettledCompletion } from "./lifecycle.ts";
import { isAuthoritativeUnsupportedModelError, type CategoryChoice, type ModelCategory } from "./model-categories.ts";

export interface RuntimeModelFailure {
  errorMessage: string;
  model: string;
}

function splitIdentity(provider: unknown, model: unknown): { provider?: string; model?: string; contradictory?: boolean } {
  const explicitProvider = typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
  if (typeof model !== "string" || !model.trim()) return { provider: explicitProvider };
  const value = model.trim();
  if (explicitProvider) {
    const prefix = `${explicitProvider}/`;
    return { provider: explicitProvider, model: value.startsWith(prefix) ? value.slice(prefix.length) : value };
  }
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return { model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function quotedModel(errorMessage: string, model: string, provider: string): boolean {
  return errorMessage.includes(`${provider}/${model}`) ||
    errorMessage.includes(`'${model}'`) || errorMessage.includes(`“${model}”`) || errorMessage.includes(`\`${model}\``);
}

/**
 * Runtime rejection identity policy: explicit provider/model fields must agree
 * with the pinned launch. If the provider omitted model metadata, accept only an
 * exact quoted or provider-qualified pinned model in the authoritative error.
 */
export function runtimeRejectionMatchesPinned(message: any, pinned: CategoryChoice): boolean {
  if (!isAuthoritativeUnsupportedModelError(message)) return false;
  const expected = splitIdentity(pinned.provider, pinned.model);
  const reported = splitIdentity(message.provider, message.model);
  if (expected.contradictory || reported.contradictory || !expected.provider || !expected.model) return false;
  if (reported.provider && reported.provider !== expected.provider) return false;
  if (reported.model) return reported.model === expected.model;
  return quotedModel(message.errorMessage, expected.model, expected.provider);
}

function failureFromMessage(message: any, pinned: CategoryChoice): RuntimeModelFailure {
  const expected = splitIdentity(pinned.provider, pinned.model);
  return { errorMessage: message.errorMessage, model: `${expected.provider}/${expected.model}` };
}

/** The latest structured outcome controls; an earlier rejection cannot invalidate a later retry or model switch. */
export function findRuntimeModelRejection(messages: any[], pinned: CategoryChoice): RuntimeModelFailure | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]?.message ?? messages[index];
    if (isAuthoritativeUnsupportedModelError(message)) {
      return runtimeRejectionMatchesPinned(message, pinned) ? failureFromMessage(message, pinned) : undefined;
    }
    if (message?.role === "assistant" && message.stopReason !== "error" && Array.isArray(message.content) &&
      message.content.some((part: any) => part?.type === "toolCall" ||
        (part?.type === "text" && typeof part.text === "string" && part.text.trim()))) return undefined;
  }
  return undefined;
}

/**
 * Interactive children are stopped only after Pi records a current-launch
 * settled marker and the entire snapshot contains no successful work.
 */
export function startupUnsupportedFailure(entries: any[], pinned: CategoryChoice): RuntimeModelFailure | undefined {
  if (!getSettledCompletion(entries as any)) return undefined;
  let performedWork = false;
  const assistantMessages: any[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "toolResult") performedWork = true;
    if (message?.role !== "assistant") continue;
    assistantMessages.push(message);
    if (!Array.isArray(message.content)) continue;
    if (message.content.some((part: any) => part?.type === "toolCall")) performedWork = true;
    if (message.stopReason !== "error" && message.content.some((part: any) =>
      part?.type === "text" && typeof part.text === "string" && part.text.trim())) performedWork = true;
  }
  if (performedWork) return undefined;
  return findRuntimeModelRejection(assistantMessages, pinned);
}

export function formatRuntimeModelRejection(category: ModelCategory, originalFailure: string, replacement: any): string {
  if (!replacement || replacement.kind === "cancelled") return originalFailure;
  if (replacement.kind === "resolved") {
    return `${originalFailure}\n\nModel category '${category}': a replacement was saved for the next launch. This task was not replayed.`;
  }
  return `${originalFailure}\n\nModel category '${category}' was rejected. Ask Nigel to choose a replacement; this task was not replayed.`;
}
