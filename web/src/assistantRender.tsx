import { marked } from 'marked';
import type { AssistantOutputItem, OutputItem } from '../../shared/types';
import { isAssistantItem } from './appUtils';

marked.setOptions({ gfm: true, breaks: true });

export function renderAssistant(item: AssistantOutputItem, pending = false) {
  const answer = typeof item.answer === 'string' ? item.answer : String(item.text || '');
  const statusText = !answer ? String(item.status || item.text || '').trim() : '';
  const assistantHtml = String(marked.parse(answer));

  if (item.type === 'diff') {
    return <pre className="fx-diff">{answer}</pre>;
  }
  if (pending && !answer && !statusText) return null;
  if (statusText === '・・・') return null;
  if (!answer && statusText) return <div className="fx-stream-status">{statusText}</div>;
  if (pending && answer) {
    return (
      <div
        className="fx-assistant-rich fx-message-body-copy fx-stream-live"
        dangerouslySetInnerHTML={{ __html: assistantHtml }}
      />
    );
  }
  return (
    <div
      className="fx-assistant-rich fx-message-body-copy"
      dangerouslySetInnerHTML={{ __html: assistantHtml }}
    />
  );
}

export function expandAssistantItems(items: OutputItem[]): OutputItem[] {
  const src = Array.isArray(items) ? items : [];
  const out: OutputItem[] = [];
  for (const item of src) {
    if (isAssistantItem(item)) {
      const answer =
        typeof item.answer === 'string' && item.answer.length > 0
          ? item.answer
          : String(item.text || '');
      out.push({
        ...item,
        answer,
        text: answer,
        reasoning: ''
      });
      continue;
    }
    out.push(item);
  }
  return out;
}
