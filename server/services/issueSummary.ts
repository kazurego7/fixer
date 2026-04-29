import { getErrorMessage } from '../errors';
import { asObject, asString } from '../json';
import { pushRuntimeLog } from '../runtimeLogs';
import type { IssueService, IssueSummaryDraft } from './issues';
import type { ThreadMessageReadResult, ThreadMessageTurn } from './liveTurn';
import type { OutputItem, TurnStartOverrides } from '../../shared/types';

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

interface IssueSummaryServiceOptions {
  issueService: IssueService;
  repoPathFromFullName: (fullName: string) => string;
  defaultThreadSandbox: string;
  rpcRequest: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  startTurnWithRetry: (
    threadId: string,
    input: TurnInputItem[],
    maxAttempts?: number,
    onRetry?: ((payload: StartTurnRetryPayload) => void) | null,
    overrides?: TurnStartOverrides | null
  ) => Promise<string>;
  buildTurnInput: (
    prompt: string,
    attachments: Array<{ type?: string; dataUrl?: string }> | null | undefined
  ) => TurnInputItem[];
  normalizeTurnMessages: (turn: ThreadMessageTurn | null | undefined) => OutputItem[];
  setThreadModel: (threadId: string, model: string) => void;
}

export interface IssueSummaryService {
  summarizeIssueMarkersForTurn(sourceThreadId: string, sourceTurnId: string | null): Promise<void>;
}

function stripMarkdownJsonFence(text: string): string {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ? fenced[1].trim() : trimmed;
}

export function parseIssueSummaryOutput(text: string): IssueSummaryDraft {
  const parsed = JSON.parse(stripMarkdownJsonFence(text));
  const record = asObject(parsed);
  const title = asString(record?.title)?.trim();
  const summary = asString(record?.summary)?.trim();
  const nextPrompt = asString(record?.nextPrompt)?.trim();
  if (!title || !summary || !nextPrompt) {
    throw new Error('issue_summary_json_invalid');
  }
  return { title, summary, nextPrompt };
}

function isAssistantOutputItem(item: OutputItem): item is OutputItem & { role: 'assistant'; answer?: string; plan?: string } {
  return item.role === 'assistant';
}

function extractAgentTextFromTurn(turn: ThreadMessageTurn | null | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const parts = [];
  for (const item of items) {
    if (item?.type === 'agentMessage' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n').trim();
}

function findTurnById(readResult: ThreadMessageReadResult, turnId: string): ThreadMessageTurn | null {
  const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
  return turns.find((turn) => String(turn?.id || '') === turnId) || null;
}

function buildIssueSummaryPrompt(sourceText: string): string {
  return [
    'Fixer の作業中にユーザーが Bad ボタンで目印を付けたターンを読み、ユーザーが後で対応したい課題を1件だけ要約してください。',
    '',
    '制約:',
    '- ユーザーが課題だと思った可能性が高いものだけを書く',
    '- 無理に課題を増やさない',
    '- 推測で新しい事実を足さない',
    '- 出力は JSON オブジェクトのみ。Markdown や説明文は禁止',
    '- キーは title, summary, nextPrompt の3つだけ',
    '- nextPrompt はユーザーがチャット入力欄に転記して、そのまま対応開始できる日本語の依頼文にする',
    '',
    '対象ターン:',
    sourceText
  ].join('\n');
}

export function createIssueSummaryService(options: IssueSummaryServiceOptions): IssueSummaryService {
  const issueSummaryInFlightTurnKeys = new Set<string>();

  function extractTurnTextForIssueSummary(turn: ThreadMessageTurn): string {
    const normalized = options.normalizeTurnMessages(turn);
    return normalized
      .map((item) => {
        const role = item.role === 'user' ? 'User' : item.role === 'assistant' ? 'Assistant' : 'System';
        const answer = isAssistantOutputItem(item) ? item.answer || item.text : item.text;
        const plan = isAssistantOutputItem(item) && item.plan ? `\nPlan:\n${item.plan}` : '';
        return `${role}:\n${String(answer || '').trim()}${plan}`.trim();
      })
      .filter(Boolean)
      .join('\n\n---\n\n');
  }

  async function ensureIssueCuratorThread(repoFullName: string): Promise<string> {
    const existing = options.issueService.getCuratorThreadId(repoFullName);
    if (existing) return existing;
    const repoPath = options.repoPathFromFullName(repoFullName);
    const result = await options.rpcRequest<{ thread?: { id?: string; model?: string } }>('thread/start', {
      cwd: repoPath,
      approvalPolicy: 'never',
      sandbox: options.defaultThreadSandbox
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error('issue_curator_thread_missing');
    const model = typeof result?.thread?.model === 'string' ? result.thread.model : '';
    if (model) options.setThreadModel(threadId, model);
    options.issueService.setCuratorThreadId(repoFullName, threadId);
    return threadId;
  }

  async function waitForTurnCompletion(threadId: string, turnId: string, timeoutMs = 90000): Promise<ThreadMessageTurn> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const read = await options.rpcRequest<ThreadMessageReadResult>('thread/read', { threadId, includeTurns: true });
      const turn = findTurnById(read, turnId);
      const status = String(turn?.status || '').toLowerCase();
      if (status === 'completed') return turn as ThreadMessageTurn;
      if (status === 'failed' || status === 'interrupted' || status === 'cancelled') {
        throw new Error(`issue_summary_turn_${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    throw new Error('issue_summary_timeout');
  }

  return {
    async summarizeIssueMarkersForTurn(sourceThreadId: string, sourceTurnId: string | null): Promise<void> {
      if (!sourceThreadId || !sourceTurnId) return;
      const turnKey = `${sourceThreadId}:${sourceTurnId}`;
      if (issueSummaryInFlightTurnKeys.has(turnKey)) return;
      const markers = options.issueService.getPendingMarkersForTurn(sourceThreadId, sourceTurnId);
      if (markers.length === 0) return;

      issueSummaryInFlightTurnKeys.add(turnKey);
      const now = new Date().toISOString();
      options.issueService.markMarkersSummarizing(markers, now);

      try {
        const firstMarker = markers[0];
        if (!firstMarker) return;
        const repoFullName = firstMarker.repoFullName;
        const sourceRead = await options.rpcRequest<ThreadMessageReadResult>('thread/read', {
          threadId: sourceThreadId,
          includeTurns: true
        });
        const sourceTurn = findTurnById(sourceRead, sourceTurnId);
        if (!sourceTurn) throw new Error('issue_source_turn_not_found');
        const sourceText = extractTurnTextForIssueSummary(sourceTurn);
        if (!sourceText) throw new Error('issue_source_turn_empty');

        const curatorThreadId = await ensureIssueCuratorThread(repoFullName);
        const curatorTurnId = await options.startTurnWithRetry(
          curatorThreadId,
          options.buildTurnInput(buildIssueSummaryPrompt(sourceText), []),
          3,
          null,
          { summary: 'concise' }
        );
        const curatorTurn = await waitForTurnCompletion(curatorThreadId, curatorTurnId);
        const outputText = extractAgentTextFromTurn(curatorTurn);
        const draft = parseIssueSummaryOutput(outputText);
        const createdAt = new Date().toISOString();
        const issue = options.issueService.createIssueFromDraft({
          repoFullName,
          sourceThreadId,
          sourceTurnId,
          markerIds: markers.map((marker) => marker.id),
          draft,
          createdAt
        });
        pushRuntimeLog({
          level: 'info',
          event: 'issue_summary_created',
          repoFullName,
          sourceThreadId,
          sourceTurnId,
          issueId: issue.id
        });
      } catch (error) {
        const failedAt = new Date().toISOString();
        options.issueService.markMarkersFailed(markers, getErrorMessage(error, 'issue_summary_failed'), failedAt);
        pushRuntimeLog({
          level: 'error',
          event: 'issue_summary_failed',
          sourceThreadId,
          sourceTurnId,
          message: getErrorMessage(error, 'issue_summary_failed')
        });
      } finally {
        issueSummaryInFlightTurnKeys.delete(turnKey);
      }
    }
  };
}
