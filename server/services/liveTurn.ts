import { asObject, asString } from '../json';
import type { OutputItem, TurnStreamEvent } from '../../shared/types';

export interface ThreadMessageContentPart {
  type?: string;
  text?: string;
  url?: string;
}

export interface ThreadMessageTurnItem {
  id?: string;
  type?: string;
  text?: string;
  phase?: string | null;
  summary?: string[];
  content?: ThreadMessageContentPart[];
}

export interface ThreadMessageTurn {
  id?: string;
  input?: Array<{ type?: string; text?: string }>;
  items?: ThreadMessageTurnItem[];
  status?: string;
}

export interface ThreadMessageReadResult {
  thread?: {
    model?: string;
    turns?: ThreadMessageTurn[];
  };
}

export interface LiveTurnState {
  threadId: string;
  turnId: string;
  items: ThreadMessageTurnItem[];
  itemOrder: string[];
  latestSeq: number;
  renderItems: OutputItem[];
  liveReasoningRaw: string;
  liveReasoningText: string;
  buffer: Array<{ seq: number; event: TurnStreamEvent }>;
}

interface LiveTurnManagerOptions {
  normalizeTurnMessages: (turn: ThreadMessageTurn | null | undefined) => OutputItem[];
  extractDisplayReasoningText: (raw: string) => string;
  nextSeq: () => number;
}

export interface LiveTurnManager {
  getState(threadId: string): LiveTurnState | null;
  ensureState(threadId: string, turnId: string): LiveTurnState;
  subscribe(handler: (payload: { threadId: string; turnId: string; seq: number; event: TurnStreamEvent }) => void): () => boolean;
  toThreadMessageTurnItem(item: unknown): ThreadMessageTurnItem | null;
  ensureItemByType(state: LiveTurnState, itemId: string, type: string): ThreadMessageTurnItem;
  upsertItem(state: LiveTurnState, item: ThreadMessageTurnItem): ThreadMessageTurnItem;
  appendBoundary(state: LiveTurnState, boundaryId: string): void;
  extractReasoningRawFromItem(item: ThreadMessageTurnItem | null): string;
  emitEvent(state: LiveTurnState, event: TurnStreamEvent): number;
  emitStateSnapshot(state: LiveTurnState): void;
  hydrateFromTurn(turnId: string, threadId: string, turn: ThreadMessageTurn | null | undefined): LiveTurnState;
  replayEvents(state: LiveTurnState, afterSeq: number, writeEvent: (event: TurnStreamEvent) => void): number;
}

function normalizeThreadContentPart(part: unknown): ThreadMessageContentPart {
  const contentPart = asObject(part) || {};
  const normalized: ThreadMessageContentPart = {};
  const type = asString(contentPart.type);
  const text = asString(contentPart.text);
  const url = asString(contentPart.url) || asString(contentPart.image_url);
  if (type) normalized.type = type;
  if (text) normalized.text = text;
  if (url) normalized.url = url;
  return normalized;
}

export function createLiveTurnManager(options: LiveTurnManagerOptions): LiveTurnManager {
  const liveTurnStateByThreadId = new Map<string, LiveTurnState>();
  const subscribers = new Set<
    (payload: { threadId: string; turnId: string; seq: number; event: TurnStreamEvent }) => void
  >();

  function trimBuffer(state: LiveTurnState, max = 300): void {
    if (state.buffer.length <= max) return;
    state.buffer.splice(0, state.buffer.length - max);
  }

  function findItem(state: LiveTurnState, itemId: string): ThreadMessageTurnItem | null {
    const idx = state.itemOrder.indexOf(itemId);
    if (idx < 0) return null;
    return state.items[idx] || null;
  }

  function rebuildRender(state: LiveTurnState): void {
    const turn: ThreadMessageTurn = {
      id: state.turnId,
      input: [],
      items: state.items.map((item) => {
        const normalized: ThreadMessageTurnItem = {};
        if (item.id) normalized.id = item.id;
        if (item.type) normalized.type = item.type;
        if (item.text !== undefined) normalized.text = item.text;
        if (item.phase !== undefined) normalized.phase = item.phase;
        if (Array.isArray(item.summary)) normalized.summary = [...item.summary];
        if (Array.isArray(item.content)) normalized.content = item.content.map((part) => ({ ...part }));
        return normalized;
      })
    };
    state.renderItems = options.normalizeTurnMessages(turn);
    state.liveReasoningText = options.extractDisplayReasoningText(state.liveReasoningRaw);
  }

  function buildCurrentTurnStateEvent(state: LiveTurnState): TurnStreamEvent {
    return {
      type: 'turn_state',
      seq: state.latestSeq,
      turnId: state.turnId,
      items: state.renderItems,
      liveReasoningText: state.liveReasoningText
    };
  }

  return {
    getState(threadId: string): LiveTurnState | null {
      return liveTurnStateByThreadId.get(threadId) || null;
    },

    ensureState(threadId: string, turnId: string): LiveTurnState {
      const existing = liveTurnStateByThreadId.get(threadId);
      if (existing && existing.turnId === turnId) return existing;
      const created: LiveTurnState = {
        threadId,
        turnId,
        items: [],
        itemOrder: [],
        latestSeq: 0,
        renderItems: [],
        liveReasoningRaw: '',
        liveReasoningText: '',
        buffer: []
      };
      liveTurnStateByThreadId.set(threadId, created);
      return created;
    },

    subscribe(handler): () => boolean {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },

    toThreadMessageTurnItem(item: unknown): ThreadMessageTurnItem | null {
      const record = asObject(item);
      if (!record) return null;
      const type = asString(record.type);
      const id = asString(record.id);
      if (!type || !id) return null;
      const normalized: ThreadMessageTurnItem = { id, type };
      if (typeof record.text === 'string') normalized.text = record.text;
      if (typeof record.phase === 'string') normalized.phase = record.phase;
      if (Array.isArray(record.summary)) normalized.summary = record.summary.map((part) => String(part || ''));
      if (Array.isArray(record.content)) {
        normalized.content = record.content
          .filter((part) => part && typeof part === 'object')
          .map((part) => normalizeThreadContentPart(part));
      }
      return normalized;
    },

    ensureItemByType(state: LiveTurnState, itemId: string, type: string): ThreadMessageTurnItem {
      const found = findItem(state, itemId);
      if (found) return found;
      const created: ThreadMessageTurnItem = { id: itemId, type };
      if (type === 'reasoning') {
        created.summary = [];
        created.content = [];
      }
      if (type === 'agentMessage' || type === 'plan') {
        created.text = '';
      }
      return this.upsertItem(state, created);
    },

    upsertItem(state: LiveTurnState, item: ThreadMessageTurnItem): ThreadMessageTurnItem {
      const itemId = asString(item.id);
      if (!itemId) return item;
      const idx = state.itemOrder.indexOf(itemId);
      const cloned: ThreadMessageTurnItem = {};
      if (item.id) cloned.id = item.id;
      if (item.type) cloned.type = item.type;
      if (item.text !== undefined) cloned.text = item.text;
      if (item.phase !== undefined) cloned.phase = item.phase;
      if (Array.isArray(item.summary)) cloned.summary = [...item.summary];
      if (Array.isArray(item.content)) cloned.content = item.content.map((part) => ({ ...part }));
      if (idx >= 0) {
        state.items[idx] = cloned;
        return state.items[idx] as ThreadMessageTurnItem;
      }
      state.itemOrder.push(itemId);
      state.items.push(cloned);
      return state.items[state.items.length - 1] as ThreadMessageTurnItem;
    },

    appendBoundary(state: LiveTurnState, boundaryId: string): void {
      if (!boundaryId) return;
      const last = state.items[state.items.length - 1];
      if (last?.id === boundaryId) return;
      state.itemOrder.push(boundaryId);
      state.items.push({ id: boundaryId, type: 'request_user_input' });
    },

    extractReasoningRawFromItem(item: ThreadMessageTurnItem | null): string {
      if (!item || item.type !== 'reasoning') return '';
      const summaryText = Array.isArray(item.summary) ? item.summary.join('\n').trim() : '';
      if (summaryText) return summaryText;
      const contentText = Array.isArray(item.content)
        ? item.content
            .map((part) => String(part?.text || ''))
            .filter(Boolean)
            .join('\n')
            .trim()
        : '';
      return contentText;
    },

    emitEvent(state: LiveTurnState, event: TurnStreamEvent): number {
      const seq = options.nextSeq();
      state.latestSeq = seq;
      const normalizedEvent =
        event.type === 'turn_state'
          ? {
              ...event,
              seq
            }
          : event;
      state.buffer.push({ seq, event: normalizedEvent });
      trimBuffer(state);
      for (const subscriber of subscribers) {
        subscriber({
          threadId: state.threadId,
          turnId: state.turnId,
          seq,
          event: normalizedEvent
        });
      }
      return seq;
    },

    emitStateSnapshot(state: LiveTurnState): void {
      rebuildRender(state);
      this.emitEvent(state, buildCurrentTurnStateEvent(state));
    },

    hydrateFromTurn(turnId: string, threadId: string, turn: ThreadMessageTurn | null | undefined): LiveTurnState {
      const state = this.ensureState(threadId, turnId);
      state.items = [];
      state.itemOrder = [];
      state.buffer = [];
      state.latestSeq = 0;
      state.liveReasoningRaw = '';
      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const rawItem of items) {
        const normalized = this.toThreadMessageTurnItem(rawItem);
        if (!normalized) continue;
        this.upsertItem(state, normalized);
        const reasoningRaw = this.extractReasoningRawFromItem(normalized);
        if (reasoningRaw) state.liveReasoningRaw = reasoningRaw;
      }
      rebuildRender(state);
      return state;
    },

    replayEvents(state: LiveTurnState, afterSeq: number, writeEvent: (event: TurnStreamEvent) => void): number {
      let lastSentSeq = afterSeq;
      const buffered = state.buffer.filter((entry) => entry.seq > afterSeq);
      if (buffered.length === 0) {
        if (state.latestSeq > afterSeq) {
          writeEvent(buildCurrentTurnStateEvent(state));
          return state.latestSeq;
        }
        return lastSentSeq;
      }
      for (const entry of buffered) {
        writeEvent(entry.event);
        lastSentSeq = entry.seq;
      }
      return lastSentSeq;
    }
  };
}
