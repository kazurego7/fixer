export type FileRenderLineKind = 'context' | 'added' | 'removed';

export const FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX = 26;
export const FILE_VIEW_VIRTUAL_OVERSCAN = 24;
export const FILE_VIEW_VIRTUALIZE_THRESHOLD = 300;
export const FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX = 8;

export interface FileRenderLine {
  key: string;
  kind: FileRenderLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export function splitFileContentLines(content: string): string[] {
  const lines = String(content || '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function parseUnifiedHunks(diffText: string): Array<{ oldStart: number; newStart: number; lines: string[] }> {
  const rawLines = String(diffText || '').split('\n');
  const hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> = [];
  let current: { oldStart: number; newStart: number; lines: string[] } | null = null;

  for (const rawLine of rawLines) {
    const line = String(rawLine || '');
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(hunkMatch[1]),
        newStart: Number(hunkMatch[2]),
        lines: []
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    current.lines.push(line);
  }

  if (current) hunks.push(current);
  return hunks;
}

export function buildFileRenderLines(content: string, diffText: string): FileRenderLine[] {
  const contentLines = splitFileContentLines(content);
  if (!diffText.trim()) {
    return contentLines.map((line, index) => ({
      key: `ctx:${index + 1}`,
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: line
    }));
  }

  const hunks = parseUnifiedHunks(diffText);
  if (hunks.length === 0) {
    return contentLines.map((line, index) => ({
      key: `ctx:${index + 1}`,
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: line
    }));
  }

  const out: FileRenderLine[] = [];
  let contentIndex = 1;

  for (const hunk of hunks) {
    while (contentIndex < hunk.newStart && contentIndex <= contentLines.length) {
      const text = contentLines[contentIndex - 1] ?? '';
      out.push({
        key: `ctx:${contentIndex}`,
        kind: 'context',
        oldLine: contentIndex,
        newLine: contentIndex,
        text
      });
      contentIndex += 1;
    }

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0] || ' ';
      const text = line.slice(1);
      if (prefix === '+') {
        out.push({
          key: `add:${newLine}:${text}`,
          kind: 'added',
          oldLine: null,
          newLine,
          text
        });
        newLine += 1;
        contentIndex += 1;
        continue;
      }
      if (prefix === '-') {
        out.push({
          key: `del:${oldLine}:${text}`,
          kind: 'removed',
          oldLine,
          newLine: null,
          text
        });
        oldLine += 1;
        continue;
      }
      out.push({
        key: `ctx:${newLine}:${text}`,
        kind: 'context',
        oldLine,
        newLine,
        text
      });
      oldLine += 1;
      newLine += 1;
      contentIndex += 1;
    }
  }

  while (contentIndex <= contentLines.length) {
    const text = contentLines[contentIndex - 1] ?? '';
    out.push({
      key: `ctx:${contentIndex}`,
      kind: 'context',
      oldLine: contentIndex,
      newLine: contentIndex,
      text
    });
    contentIndex += 1;
  }

  return out;
}

export function findVirtualLineIndex(offsets: number[], targetOffset: number): number {
  if (offsets.length <= 1) return 0;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((offsets[mid] ?? 0) <= targetOffset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return Math.max(0, Math.min(offsets.length - 2, low - 1));
}
