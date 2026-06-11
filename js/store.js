// localStorage persistence: API key, last account, and compact match records
// (so re-analyzing doesn't burn the Riot rate limit on matches we already have).

const KEY_APIKEY = 'hc_apikey';
const KEY_SETTINGS = 'hc_settings';
const KEY_MATCH_PREFIX = 'hc_m_'; // hc_m_<puuid-prefix>_<matchId>

export function getApiKey() { return localStorage.getItem(KEY_APIKEY) || ''; }
export function setApiKey(k) { localStorage.setItem(KEY_APIKEY, k.trim()); }

const KEY_GITHUB = 'hc_github_token';
export function getGithubToken() { return localStorage.getItem(KEY_GITHUB) || ''; }
export function setGithubToken(t) { localStorage.setItem(KEY_GITHUB, t.trim()); }

export function getSettings() {
  try { return JSON.parse(localStorage.getItem(KEY_SETTINGS)) || {}; }
  catch { return {}; }
}
export function saveSettings(s) {
  localStorage.setItem(KEY_SETTINGS, JSON.stringify({ ...getSettings(), ...s }));
}

function matchKey(puuid, matchId) {
  return `${KEY_MATCH_PREFIX}${puuid.slice(0, 12)}_${matchId}`;
}

export function getCachedRecord(puuid, matchId) {
  try { return JSON.parse(localStorage.getItem(matchKey(puuid, matchId))); }
  catch { return null; }
}

export function cacheRecord(puuid, matchId, record) {
  try {
    localStorage.setItem(matchKey(puuid, matchId), JSON.stringify(record));
  } catch {
    // localStorage full — evict oldest cached matches and retry once
    evictOldestMatches(50);
    try { localStorage.setItem(matchKey(puuid, matchId), JSON.stringify(record)); } catch { /* give up */ }
  }
}

function evictOldestMatches(n) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_MATCH_PREFIX)) keys.push(k);
  }
  keys.sort(); // matchIds sort roughly chronologically per region
  for (const k of keys.slice(0, n)) localStorage.removeItem(k);
}

export function clearMatchCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_MATCH_PREFIX)) keys.push(k);
  }
  keys.forEach(k => localStorage.removeItem(k));
  return keys.length;
}
