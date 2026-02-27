const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.cwd(), 'workspace');
const CODEX_BASE_URL = process.env.CODEX_BASE_URL || 'http://127.0.0.1:8080';

if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

const cloneJobs = new Map();

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function repoFolderFromFullName(fullName) {
  return fullName.replace(/[\\/]/g, '__');
}

function repoPathFromFullName(fullName) {
  return path.join(WORKSPACE_ROOT, repoFolderFromFullName(fullName));
}

function getCloneState(fullName) {
  const repoPath = repoPathFromFullName(fullName);
  const job = cloneJobs.get(fullName);

  if (job?.status === 'cloning') return { status: 'cloning', repoPath };
  if (job?.status === 'failed') return { status: 'failed', repoPath, error: job.error };
  if (fs.existsSync(path.join(repoPath, '.git'))) return { status: 'cloned', repoPath };
  return { status: 'not_cloned', repoPath };
}

function runClone(fullName, cloneUrl) {
  const repoPath = repoPathFromFullName(fullName);
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    cloneJobs.set(fullName, { status: 'cloned' });
    return;
  }

  cloneJobs.set(fullName, { status: 'cloning' });

  const child = spawn('git', ['clone', '--depth', '1', cloneUrl, repoPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('close', (code) => {
    if (code === 0) {
      cloneJobs.set(fullName, { status: 'cloned' });
      return;
    }
    cloneJobs.set(fullName, { status: 'failed', error: stderr.trim() || `git clone exited with code ${code}` });
  });
}

async function githubRepos(token, query) {
  const endpoint = query
    ? `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+user:@me`
    : 'https://api.github.com/user/repos?per_page=100&sort=updated';

  const headers = {
    'User-Agent': 'codex-mobile-ui',
    Accept: 'application/vnd.github+json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_error:${response.status}:${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const repos = Array.isArray(data) ? data : data.items || [];

  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
    cloneState: getCloneState(repo.full_name)
  }));
}

async function codexRequest(method, endpoint, body) {
  const response = await fetch(`${CODEX_BASE_URL}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`codex_error:${response.status}:${text.slice(0, 200)}`);
  }
  return json;
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  const file = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(file).replace(/^\.\.(?:\/|\\|$)/, '');
  const filePath = path.join(process.cwd(), 'public', safe);

  if (!filePath.startsWith(path.join(process.cwd(), 'public'))) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, workspaceRoot: WORKSPACE_ROOT, codexBaseUrl: CODEX_BASE_URL });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/github/repos') {
      const token = req.headers['x-github-token'] || '';
      const query = url.searchParams.get('query') || '';
      const repos = await githubRepos(token, query);
      sendJson(res, 200, { repos });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/repos/clone') {
      const body = await parseBody(req);
      if (!body.fullName || !body.cloneUrl) {
        sendJson(res, 400, { error: 'fullName and cloneUrl are required' });
        return;
      }

      runClone(body.fullName, body.cloneUrl);
      sendJson(res, 202, getCloneState(body.fullName));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/repos/clone-status') {
      const fullName = url.searchParams.get('fullName');
      if (!fullName) {
        sendJson(res, 400, { error: 'fullName is required' });
        return;
      }
      sendJson(res, 200, getCloneState(fullName));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/threads') {
      const repoFullName = url.searchParams.get('repoFullName');
      if (!repoFullName) return sendJson(res, 400, { error: 'repoFullName is required' });
      const repoPath = repoPathFromFullName(repoFullName);
      const data = await codexRequest('GET', `/threads?workspace=${encodeURIComponent(repoPath)}`);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/threads') {
      const body = await parseBody(req);
      if (!body.repoFullName) return sendJson(res, 400, { error: 'repoFullName is required' });
      const repoPath = repoPathFromFullName(body.repoFullName);
      const data = await codexRequest('POST', '/threads', { workspace: repoPath, title: body.title || '' });
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/turns/stream') {
      const body = await parseBody(req);
      const response = await fetch(`${CODEX_BASE_URL}/turns/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok || !response.body) {
        const txt = await response.text();
        sendJson(res, response.status || 500, { error: txt || 'stream_error' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/turns/cancel') {
      const body = await parseBody(req);
      const data = await codexRequest('POST', '/turns/cancel', body);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/approvals/respond') {
      const body = await parseBody(req);
      const data = await codexRequest('POST', '/approvals/respond', body);
      sendJson(res, 200, data);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'internal_error' });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { repoFolderFromFullName, repoPathFromFullName, getCloneState };
