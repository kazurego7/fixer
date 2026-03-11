export function extractDisplayReasoningText(raw: string): string {
  const source = String(raw || '');
  const marker = /\*\*([^*\n][^*\n]*)\*\*/g;
  const matches: Array<{ markerEnd: number; title: string }> = [];
  let found = marker.exec(source);
  while (found) {
    matches.push({
      markerEnd: marker.lastIndex,
      title: String(found[1] || '').trim()
    });
    found = marker.exec(source);
  }
  if (matches.length === 0) return source.trim();
  const current = matches[matches.length - 1];
  if (!current) return source.trim();
  const body = source.slice(current.markerEnd).trim();
  return [current.title, body].filter(Boolean).join('\n').trim();
}
