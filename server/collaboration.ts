import type {
  CollaborationMode,
  CollaborationModeOverride,
  ModelOption,
  TurnStartOverrides
} from '../shared/types';
import type { JsonRecord } from './json';

export const DEFAULT_MODEL_FALLBACK = 'gpt-5-codex';
export const DEFAULT_REASONING_SUMMARY = 'concise';
export const DEFAULT_THREAD_SANDBOX = 'danger-full-access';

export function normalizeModelId(value: unknown): string {
  const model = String(value || '').trim();
  return model || '';
}

export function normalizeModelListResponse(payload: JsonRecord | null | undefined): ModelOption[] {
  const src = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { id?: unknown; model?: unknown; name?: unknown; display_name?: unknown; description?: unknown; summary?: unknown };
    const id = normalizeModelId(record.id || record.model || record.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(record.name || record.display_name || id),
      description: String(record.description || record.summary || '')
    });
  }
  return out;
}

export function normalizeCollaborationMode(value: unknown): CollaborationMode | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === 'plan') return 'plan';
  if (normalized === 'default' || normalized === 'normal') return 'default';
  return null;
}

export function buildCollaborationMode(mode: CollaborationMode, model: string): CollaborationModeOverride {
  return {
    mode,
    settings: {
      model: String(model || DEFAULT_MODEL_FALLBACK),
      reasoning_effort: null,
      developer_instructions: null
    }
  };
}

export async function buildTurnStartOverridesWithModelResolver(
  threadId: string,
  options: { selectedModel?: string; collaborationMode?: CollaborationMode | null } = {},
  resolveThreadModel: (threadId: string) => Promise<string>
): Promise<TurnStartOverrides> {
  const selectedModel = normalizeModelId(options.selectedModel);
  const collaborationMode = normalizeCollaborationMode(options.collaborationMode);
  const overrides: TurnStartOverrides = {
    summary: DEFAULT_REASONING_SUMMARY
  };

  if (selectedModel) {
    overrides.model = selectedModel;
  }

  if (collaborationMode) {
    const effectiveModel = selectedModel || (await resolveThreadModel(threadId));
    overrides.collaborationMode = buildCollaborationMode(collaborationMode, effectiveModel);
  }

  return overrides;
}
