// GitHub Gist sync — talks to our own /api/gist serverless proxy (which holds the
// secret token). Keeps a single private gist that logs the *parameters* of every
// analysis run (no match results). Disabled if the server has no token.

const PROXY = '/api/gist';
const GIST_DESC = 'LoL HardCounter analysis log (auto-managed)';
const LOG_FILE = 'lol-hardcounter-log.json';

async function gh(path, opts = {}) {
  const res = await fetch(`${PROXY}?path=${encodeURIComponent(path)}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body,
  });
  if (res.status === 501) throw new Error('GitHub sync is not configured on the server.');
  if (res.status === 401) throw new Error('Server GitHub token invalid or expired.');
  if (res.status === 403) throw new Error('Server GitHub token lacks the "gist" scope (or rate limited).');
  if (!res.ok && res.status !== 404) throw new Error(`GitHub API error (HTTP ${res.status}).`);
  return res;
}

/** Find our gist (by description), or create it. Returns gist id. */
export async function ensureGist(cachedId = null) {
  if (cachedId) {
    const res = await gh(`/gists/${cachedId}`);
    if (res.ok) return cachedId;
  }
  const listRes = await gh('/gists?per_page=100');
  if (listRes.ok) {
    const gists = await listRes.json();
    const found = gists.find(g => g.description === GIST_DESC);
    if (found) return found.id;
  }
  const createRes = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESC,
      public: false,
      files: { 'README.md': { content: 'Match data saved by LoL HardCounter. Safe to delete if you no longer use the app.' } },
    }),
  });
  if (!createRes.ok) throw new Error('Could not create the data gist on GitHub.');
  return (await createRes.json()).id;
}

/** Read the current analysis log (array of param entries). */
async function loadLog(gistId) {
  const res = await gh(`/gists/${gistId}`);
  if (!res.ok) return [];
  const gist = await res.json();
  const file = gist.files?.[LOG_FILE];
  if (!file) return [];
  // Gist API truncates file content over ~1MB — fall back to the raw URL
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

/** Append one analysis (parameters only) to the log and save it back. */
export async function appendAnalysis(gistId, entry) {
  const log = await loadLog(gistId);
  log.push(entry);
  const res = await gh(`/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: { [LOG_FILE]: { content: JSON.stringify(log, null, 2) } },
    }),
  });
  if (!res.ok) throw new Error('Could not write to the GitHub gist.');
}
