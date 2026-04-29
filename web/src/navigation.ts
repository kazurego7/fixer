export function normalizePath(rawPath: string): string {
  const pathWithoutQuery = String(rawPath || '').split('?')[0] ?? '';
  const pathname = pathWithoutQuery.split('#')[0] ?? '';
  if (pathname === '/files' || pathname === '/files/') return '/files/';
  if (pathname === '/files/view' || pathname === '/files/view/') return '/files/view/';
  if (pathname === '/chat' || pathname === '/chat/') return '/chat/';
  if (pathname === '/repos/new' || pathname === '/repos/new/') return '/repos/new/';
  return '/repos/';
}

export function getCurrentPath(): string {
  if (typeof window === 'undefined') return '/repos/';
  const hash = window.location.hash || '';
  if (hash.startsWith('#!/')) return normalizePath(hash.slice(2));
  return normalizePath(window.location.pathname || '/');
}

export function pushPath(path: string, replace = false): string {
  const raw = String(path || '');
  const queryIndex = raw.indexOf('?');
  const search = queryIndex >= 0 ? raw.slice(queryIndex) : '';
  const target = `${normalizePath(raw)}${search}`;
  if (typeof window === 'undefined') return target;
  if (replace) window.history.replaceState({}, '', target);
  else window.history.pushState({}, '', target);
  return target;
}

export function getCurrentSearch(): string {
  if (typeof window === 'undefined') return '';
  return String(window.location.search || '');
}

export function extractSearch(rawPath: string): string {
  const queryIndex = String(rawPath || '').indexOf('?');
  return queryIndex >= 0 ? String(rawPath || '').slice(queryIndex) : '';
}

export function getCurrentFileParams(): { path: string; line: number | null; jumpToFirstDiff: boolean } {
  if (typeof window === 'undefined') return { path: '', line: null, jumpToFirstDiff: false };
  const params = new URLSearchParams(window.location.search || '');
  const filePath = String(params.get('path') || '').trim();
  const lineRaw = Number(params.get('line') || '');
  return {
    path: filePath,
    line: Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : null,
    jumpToFirstDiff: params.get('jump') === 'first-diff'
  };
}

export function buildFileViewPath(filePath: string, line: number | null = null, jumpToFirstDiff = false): string {
  const params = new URLSearchParams();
  params.set('path', filePath);
  if (line && line > 0) params.set('line', String(line));
  if (jumpToFirstDiff && !(line && line > 0)) params.set('jump', 'first-diff');
  return `/files/view/?${params.toString()}`;
}

export function parseLineAnchor(rawHref: string): { path: string; line: number | null } {
  const href = String(rawHref || '').trim();
  let pathPart = href;
  let line: number | null = null;

  const hashIndex = href.indexOf('#');
  if (hashIndex >= 0) {
    pathPart = href.slice(0, hashIndex);
    const hash = href.slice(hashIndex + 1);
    const lineMatch = hash.match(/^L(\d+)/i);
    if (lineMatch) line = Number(lineMatch[1]);
  }

  if (!line) {
    const colonMatch = pathPart.match(/:(\d+)(?::\d+)?$/);
    if (colonMatch) {
      line = Number(colonMatch[1]);
      pathPart = pathPart.slice(0, colonMatch.index);
    }
  }

  return { path: pathPart, line: line !== null && Number.isInteger(line) && line > 0 ? line : null };
}

export function resolveRepoRelativeFilePath(rawHref: string, repoPath: string): { path: string; line: number | null } | null {
  const parsed = parseLineAnchor(rawHref);
  const hrefPath = String(parsed.path || '').trim();
  if (!hrefPath) return null;
  if (/^(https?:|mailto:|tel:)/i.test(hrefPath)) return null;

  let absolutePath = '';
  if (hrefPath.startsWith('file://')) {
    try {
      absolutePath = decodeURIComponent(new URL(hrefPath).pathname || '');
    } catch {
      return null;
    }
  } else if (hrefPath.startsWith('/')) {
    absolutePath = hrefPath;
  } else {
    absolutePath = `${repoPath.replace(/[\\/]+$/, '')}/${hrefPath}`;
  }

  const normalizedRepo = repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedAbsolute = absolutePath.replace(/\\/g, '/');
  if (normalizedAbsolute === normalizedRepo || !normalizedAbsolute.startsWith(`${normalizedRepo}/`)) return null;

  return {
    path: normalizedAbsolute.slice(normalizedRepo.length + 1),
    line: parsed.line
  };
}
