import { asObject, asString } from '../lib/json';
import type { ThreadMessageReadResult, ThreadMessageTurn } from './liveTurn';
import type { OutputItem } from '../../shared/types';

function looksLikeDiff(text: string): boolean {
  return /^diff --git/m.test(text) || /^@@/m.test(text) || /^\+\+\+/m.test(text);
}

function isUserInputBoundaryItem(item: unknown): boolean {
  const record = asObject(item);
  if (!record) return false;
  const type = (asString(record.type) || '').toLowerCase();
  const method = (asString(record.method) || '').toLowerCase();
  const name = (asString(record.name) || '').toLowerCase();
  const toolName = (asString(record.toolName) || '').toLowerCase();
  return (
    type.includes('requestuserinput') ||
    type.includes('request_user_input') ||
    type.includes('userinputrequest') ||
    method === 'item/tool/requestuserinput' ||
    name.includes('requestuserinput') ||
    name.includes('request_user_input') ||
    toolName.includes('requestuserinput') ||
    toolName.includes('request_user_input')
  );
}

function extractUserMessageText(item: unknown): string {
  const record = asObject(item);
  if (!record || record.type !== 'userMessage') return '';
  const content = Array.isArray(record.content) ? record.content : [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function normalizeTurnMessages(turn: ThreadMessageTurn | null | undefined): OutputItem[] {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const input = Array.isArray(turn?.input) ? turn.input : [];
  const messages: OutputItem[] = [];
  let userIndex = 0;
  let assistantIndex = 0;
  let currentAnswerParts: string[] = [];
  let currentPlanParts: string[] = [];

  function pushUserMessage(text: string): void {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    messages.push({
      id: `${turn?.id}:user:${userIndex}`,
      role: 'user',
      type: 'plain',
      text: normalized
    });
    userIndex += 1;
  }

  function flushAssistantSegment(): void {
    const answerText = currentAnswerParts.join('\n');
    const planText = currentPlanParts.join('\n');
    if (!answerText && !planText) return;
    messages.push({
      id: `${turn?.id}:assistant:${assistantIndex}`,
      role: 'assistant',
      type: looksLikeDiff(answerText) ? 'diff' : 'markdown',
      text: answerText,
      answer: answerText,
      plan: planText
    });
    assistantIndex += 1;
    currentAnswerParts = [];
    currentPlanParts = [];
  }

  const hasUserMessageItems = items.some((item) => item?.type === 'userMessage');
  if (!hasUserMessageItems) {
    const userTextFromInput = input
      .filter((item: { type?: string; text?: string }) => item?.type === 'text' && typeof item.text === 'string')
      .map((item: { type?: string; text?: string }) => item.text as string)
      .join('\n')
      .trim();
    pushUserMessage(userTextFromInput);
  }

  for (const item of items) {
    if (item?.type === 'userMessage') {
      flushAssistantSegment();
      pushUserMessage(extractUserMessageText(item));
      continue;
    }
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      currentAnswerParts.push(item.text);
      continue;
    }
    if (item?.type === 'plan' && typeof item.text === 'string') {
      currentPlanParts.push(item.text);
      continue;
    }
    if (isUserInputBoundaryItem(item)) {
      flushAssistantSegment();
    }
  }
  flushAssistantSegment();

  return messages;
}

export function normalizeThreadMessages(readResult: ThreadMessageReadResult): OutputItem[] {
  const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
  return turns.flatMap((turn) => normalizeTurnMessages(turn));
}
