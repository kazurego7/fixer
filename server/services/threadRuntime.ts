import { pushRuntimeLog } from '../infra/runtimeLogs';
import { buildTurnStartOverridesWithModelResolver } from '../lib/collaboration';
import { getErrorMessage } from '../lib/errors';
import type { JsonRecord } from '../lib/json';
import type { ThreadMessageReadResult } from './liveTurn';
import { isThreadWarmupError } from './turnNotifications';
import type { CollaborationMode, TurnStartOverrides } from '../../shared/types';

interface StartTurnRetryPayload {
  attempt: number;
  message: string;
}

interface TurnInputTextItem {
  type: 'text';
  text: string;
}

interface TurnInputImageItem {
  type: 'image';
  url: string;
}

type TurnInputItem = TurnInputTextItem | TurnInputImageItem;

interface ThreadRuntimeOptions {
  rpcRequest: <T = unknown>(method: string, params?: JsonRecord) => Promise<T>;
  defaultModelFallback: string;
}

export interface ThreadRuntimeService {
  setThreadModel(threadId: string, model: string): void;
  resolveThreadModel(threadId: string): Promise<string>;
  buildTurnStartOverrides(
    threadId: string,
    options?: { selectedModel?: string; collaborationMode?: CollaborationMode | null }
  ): Promise<TurnStartOverrides>;
  startTurnWithRetry(
    threadId: string,
    input: TurnInputItem[],
    maxAttempts?: number,
    onRetry?: ((payload: StartTurnRetryPayload) => void) | null,
    overrides?: TurnStartOverrides | null
  ): Promise<string>;
  isThreadMissingError(error: unknown): boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createThreadRuntimeService(options: ThreadRuntimeOptions): ThreadRuntimeService {
  const threadModelByThreadId = new Map<string, string>();

  return {
    setThreadModel(threadId: string, model: string): void {
      threadModelByThreadId.set(threadId, model);
    },

    async resolveThreadModel(threadId: string): Promise<string> {
      const cached = threadModelByThreadId.get(threadId);
      if (cached) return cached;

      try {
        const read = await options.rpcRequest<ThreadMessageReadResult>('thread/read', { threadId, includeTurns: false });
        const model = typeof read?.thread?.model === 'string' ? read.thread.model : '';
        if (model) {
          threadModelByThreadId.set(threadId, model);
          return model;
        }
      } catch {
        // 取得に失敗した場合は次のフォールバックを試す。
      }

      try {
        const config = await options.rpcRequest<{ config?: { model?: string } }>('config/read', { includeLayers: false });
        const model = typeof config?.config?.model === 'string' ? config.config.model : '';
        if (model) return model;
      } catch {
        // 設定読取に失敗した場合は固定モデルにフォールバックする。
      }

      return options.defaultModelFallback;
    },

    async buildTurnStartOverrides(
      threadId: string,
      turnOptions: { selectedModel?: string; collaborationMode?: CollaborationMode | null } = {}
    ): Promise<TurnStartOverrides> {
      return buildTurnStartOverridesWithModelResolver(threadId, turnOptions, this.resolveThreadModel);
    },

    async startTurnWithRetry(
      threadId: string,
      input: TurnInputItem[],
      maxAttempts = 20,
      onRetry: ((payload: StartTurnRetryPayload) => void) | null = null,
      overrides: TurnStartOverrides | null = null
    ): Promise<string> {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const turnStartParams: JsonRecord = {
            threadId,
            input,
            ...(overrides && typeof overrides === 'object' ? overrides : {})
          };
          const turnStart = await options.rpcRequest<{ turn?: { id?: string } }>('turn/start', turnStartParams);
          const turnId = turnStart?.turn?.id;
          if (!turnId) throw new Error('turn_id_missing');
          if (attempt > 1) {
            pushRuntimeLog({
              level: 'info',
              event: 'turn_start_recovered',
              threadId,
              attempt
            });
          }
          return turnId;
        } catch (error) {
          lastError = error;
          if (!isThreadWarmupError(error) || attempt === maxAttempts) throw error;
          if (typeof onRetry === 'function') {
            onRetry({
              attempt,
              message: getErrorMessage(error)
            });
          }
          pushRuntimeLog({
            level: 'info',
            event: 'turn_start_retry',
            threadId,
            attempt,
            message: getErrorMessage(error)
          });
          await sleep(Math.min(700, 100 + attempt * 60));
        }
      }
      throw lastError || new Error('turn_start_failed');
    },

    isThreadMissingError(error: unknown): boolean {
      const message = getErrorMessage(error, '');
      return (
        message.includes('thread not found') ||
        message.includes('thread_not_found') ||
        message.includes('no rollout found for thread id')
      );
    }
  };
}
