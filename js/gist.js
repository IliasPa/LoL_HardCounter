// GitHub Gist sync — stores analyzed match data in one private gist
// (one JSON file per account), so it survives browsers and devices.

const API = 'https://api.github.com';
const GIST_DESC = 'LoL HardCounter data (auto-managed)';

function fileName(puuid) {
  return `lol-hardcounter_${puuid.slice(0, 12)}.json`;
}

async function gh(token, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new Error('GitHub token invalid or expired.');
  if (res.status === 403) throw new Error('GitHub token lacks the "gist" scope (or rate limited).');
  if (!res.ok && res.status !== 404) throw new Error(`GitHub API error (HTTP ${res.status}).`);
  return res;
}

export async function whoAmI(token) {
  const res = await gh(token, '/user');
  if (!res.ok) throw new Error('GitHub token invalid.');
  return (await res.json()).login;
}

/** Find our gist (by description), or create it. Returns gist id. */
export async function ensureGist(token, cachedId = null) {
  if (cachedId) {
    const res = await gh(token, `/gists/${cachedId}`);
    if (res.ok) return cachedId;
  }
  const listRes = await gh(token, '/gists?per_page=100');
  if (listRes.ok) {
    const gists = await listRes.json();
    const found = gists.find(g => g.description === GIST_DESC);
    if (found) return found.id;
  }
  const createRes = await gh(token, '/gists', {
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

/** Save one account's records to the gist. */
export async function saveAccountData(token, gistId, puuid, payload) {
  const res = await gh(token, `/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: { [fileName(puuid)]: { content: JSON.stringify(payload) } },
    }),
  });
  if (!res.ok) throw new Error('Could not save data to the GitHub gist.');
}

/** Load one account's records from the gist. Returns payload or null. */
export async function loadAccountData(token, gistId, puuid) {
  const res = await gh(token, `/gists/${gistId}`);
  if (!res.ok) return null;
  const gist = await res.json();
  const file = gist.files?.[fileName(puuid)];
  if (!file) return null;
  // Gist API truncates file content over ~1MB — fall back to the raw URL
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  try { return JSON.parse(text); } catch { return null; }
}
