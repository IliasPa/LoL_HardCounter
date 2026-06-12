import { RiotAPI, RiotAPIError } from './riotApi.js';
import { loadStaticData, searchChampions } from './ddragon.js';
import { extractRecord, aggregate, buildStats, winrate, kda, SR_QUEUES } from './analysis.js';
import { suggestCounters, metaGaps, teamInsights } from './suggest.js';
import * as gist from './gist.js';
import * as store from './store.js';

// ---------- App state ----------
let dd = null;          // static data (champs, runes, items)
let meta = null;        // curated meta picks
let api = null;         // RiotAPI instance
let account = null;     // {puuid, gameName, tagLine}
let summoner = null;    // {profileIconId, summonerLevel}
let leagueEntries = []; // ranked solo/flex entries
let records = [];       // compact match records (the analyzed window)
let agg = null;         // aggregated stats
let enemyPicks = [];    // Counter Finder enemy champ ids
let importedCache = {}; // puuid -> {matchId: record} seeded from gist / JSON import

// UI state
let poolSort = { key: 'games', dir: -1 };   // champion pool sorting
let poolExpanded = null;                    // champ id whose builds are expanded in the pool
let poolShowAll = false;                    // pool "Show all champions" toggled
let muSort = { key: 'games', dir: -1 };     // matchups sorting
let expandedMatchId = null;                 // match id expanded in the Profile tab
let profileShowAll = false;                 // "Show all games" toggled
let live = null;                            // {game, myTeam, allies:[], enemies:[]} — arrays are user-orderable

const $ = id => document.getElementById(id);

const QUEUE_NAMES = {
  420: 'Ranked Solo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind',
  490: 'Quickplay', 450: 'ARAM', 700: 'Clash', 1700: 'Arena', 1900: 'URF',
};
const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
const ROLE_SLUG = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'middle', BOTTOM: 'bottom', UTILITY: 'utility' };
const ROLE_ICON_BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/';
const POOL_LIMIT = 10; // pool rows shown before "Show all"

function roleIconUrl(role) {
  return ROLE_SLUG[role] ? `${ROLE_ICON_BASE}icon-position-${ROLE_SLUG[role]}.png` : '';
}

function roleIcon(role) {
  const url = roleIconUrl(role);
  return url ? `<img class="role-icon" src="${url}" alt="${ROLE_LABEL[role]}" title="${ROLE_LABEL[role]}" loading="lazy"/>` : '';
}

// inline icon button group replacing the old role <select>; value lives in dataset.value
function buildRolePicker(el, onChange) {
  el.innerHTML = ['', ...Object.keys(ROLE_SLUG)].map(r => `
    <button type="button" class="role-btn${(el.dataset.value || '') === r ? ' active' : ''}" data-role="${r}"
      title="${r ? ROLE_LABEL[r] : 'Any role'}">
      ${r ? `<img src="${roleIconUrl(r)}" alt="${ROLE_LABEL[r]}"/>` : 'ALL'}
    </button>`).join('');
  el.querySelectorAll('.role-btn').forEach(b => b.onclick = () => {
    el.dataset.value = b.dataset.role;
    el.querySelectorAll('.role-btn').forEach(x => x.classList.toggle('active', x === b));
    onChange();
  });
}

const roleVal = id => $(id).dataset.value || '';

// ---------- Boot ----------
init();

function init() {
  const s = store.getSettings();
  if (s.riotId) $('riotId').value = s.riotId;
  if (s.queueFilter) $('queueFilter').value = s.queueFilter;
  if (s.matchCount) $('matchCount').value = s.matchCount;
  $('apiKey').value = store.getApiKey();
  $('githubToken').value = store.getGithubToken();
  if (!store.getApiKey()) $('settingsPanel').classList.remove('hidden');
  updateKeyStatus();
  updateGithubStatus();

  $('settingsBtn').onclick = () => $('settingsPanel').classList.toggle('hidden');
  $('saveKeyBtn').onclick = () => {
    store.setApiKey($('apiKey').value);
    updateKeyStatus();
  };
  $('clearCacheBtn').onclick = () => {
    const n = store.clearMatchCache();
    $('keyStatus').textContent = `Cleared ${n} cached matches from this browser.`;
  };
  $('saveGithubBtn').onclick = saveGithubToken;
  $('exportBtn').onclick = exportData;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = importData;
  $('analyzeBtn').onclick = analyze;
  $('riotId').addEventListener('keydown', e => { if (e.key === 'Enter') analyze(); });

  document.querySelectorAll('.tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-content').forEach(sec =>
        sec.classList.toggle('hidden', sec.id !== `tab-${btn.dataset.tab}`));
    };
  });

  setupChampSearch($('enemySearch'), $('enemySuggest'), c => { addEnemy(c.id); $('enemySearch').value = ''; });
  $('clearEnemiesBtn').onclick = () => { enemyPicks = []; renderCounterTab(); };
  buildRolePicker($('myRole'), renderCounterTab);
  $('poolMinGames').onchange = renderPool;
  $('liveBtn').onclick = checkLiveGame;

  $('muSearch').oninput = renderMatchups;
  buildRolePicker($('muRole'), renderMatchups);
  $('muMinGames').onchange = renderMatchups;
}

function updateKeyStatus() {
  $('keyStatus').textContent = store.getApiKey()
    ? '✅ Riot key saved in this browser.'
    : '⚠️ No Riot key set — the app cannot reach the Riot API without one.';
}

async function saveGithubToken() {
  const token = $('githubToken').value.trim();
  store.setGithubToken(token);
  if (!token) { $('githubStatus').textContent = 'GitHub sync disabled.'; return; }
  $('githubStatus').textContent = 'Checking token…';
  try {
    const login = await gist.whoAmI(token);
    $('githubStatus').textContent = `✅ Connected as ${login} — data will sync to a private gist after each analysis.`;
  } catch (e) {
    $('githubStatus').textContent = `❌ ${e.message}`;
  }
}

function updateGithubStatus() {
  $('githubStatus').textContent = store.getGithubToken()
    ? '✅ GitHub token saved — data syncs to a private gist after each analysis.'
    : 'No token — data stays in this browser only (you can still use file export/import).';
}

// ---------- JSON file export / import ----------
function exportData() {
  if (!account || !records.length) {
    $('fileStatus').textContent = 'Nothing to export yet — run an analysis first.';
    return;
  }
  const payload = exportPayload();
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hardcounter_${account.gameName}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('fileStatus').textContent = `Exported ${payload.records.length} matches.`;
}

function exportPayload() {
  // union of what we just analyzed and anything previously imported/synced for this account
  const merged = { ...(importedCache[account.puuid] || {}) };
  for (const r of records) merged[r.id] = r;
  return {
    v: 1,
    account: { puuid: account.puuid, gameName: account.gameName, tagLine: account.tagLine, region: api?.platform || '' },
    savedAt: Date.now(),
    records: Object.values(merged).sort((a, b) => b.ts - a.ts),
  };
}

function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      if (!payload?.account?.puuid || !Array.isArray(payload.records)) throw new Error('bad format');
      const map = importedCache[payload.account.puuid] ??= {};
      for (const r of payload.records) map[r.id] = r;
      // best-effort persist a slice to localStorage too (quota permitting)
      payload.records.slice(0, 500).forEach(r => store.cacheRecord(payload.account.puuid, r.id, r));
      $('fileStatus').textContent =
        `✅ Imported ${payload.records.length} matches for ${payload.account.gameName}#${payload.account.tagLine}. Hit Analyze to use them.`;
    } catch {
      $('fileStatus').textContent = '❌ That file is not a valid HardCounter export.';
    }
  };
  reader.readAsText(file);
}

// ---------- UI helpers ----------
function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError() { $('error').classList.add('hidden'); }

function setProgress(label, frac) {
  $('progress').classList.remove('hidden');
  $('progressLabel').textContent = label;
  $('progressFill').style.width = `${Math.round(frac * 100)}%`;
}
function hideProgress() { $('progress').classList.add('hidden'); }

function champOf(name) {
  // match-v5 championName usually equals the ddragon id, with rare casing quirks (e.g. "FiddleSticks")
  if (dd.byId[name]) return dd.byId[name];
  const lower = name.toLowerCase();
  return Object.values(dd.byId).find(c => c.id.toLowerCase() === lower)
      || dd.byName[lower]
      || { id: name, name, icon: '', tags: [], info: { attack: 5, magic: 5, defense: 5 } };
}

function champCell(name, small = false) {
  const c = champOf(name);
  return `<span class="champ-cell${small ? ' small' : ''}">
    ${c.icon ? `<img src="${c.icon}" alt="" loading="lazy" />` : ''}${c.name}</span>`;
}

function wrSpan(wr, games) {
  const cls = wr >= 0.55 ? 'good' : wr <= 0.45 ? 'bad' : 'mid';
  return `<span class="wr ${cls}">${Math.round(wr * 100)}%</span>
    <span class="wr-bar"><i style="width:${Math.round(wr * 100)}%"></i></span>` +
    (games != null ? `<span class="muted"> (${games}g)</span>` : '');
}

function kdaSpan(v) {
  const cls = v >= 4 ? 'good' : v < 2 ? 'bad' : 'mid';
  return `<span class="wr ${cls}">${v.toFixed(2)}</span>`;
}

// clickable sort header; state = {key, dir}
function sortTh(state, key, label, title = '') {
  const active = state.key === key;
  return `<th class="sortable${active ? ' sorted' : ''}" data-key="${key}" ${title ? `title="${title}"` : ''}>
    ${label}${active ? (state.dir === -1 ? ' ▼' : ' ▲') : ''}</th>`;
}

function bindSortHeaders(container, state, rerender) {
  container.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    if (state.key === th.dataset.key) state.dir *= -1;
    else { state.key = th.dataset.key; state.dir = -1; }
    rerender();
  });
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------- Analyze flow ----------
async function analyze() {
  hideError();
  const riotIdRaw = $('riotId').value.trim();
  const m = riotIdRaw.match(/^(.{2,})\s*#\s*(.{2,})$/);
  if (!m) return showError('Enter your Riot ID in the form Name#TAG (e.g. Faker#KR1).');
  if (!store.getApiKey()) {
    $('settingsPanel').classList.remove('hidden');
    return showError('Set your Riot API key first (🔑 button).');
  }

  const queueFilter = $('queueFilter').value;
  const countSetting = $('matchCount').value;
  const maxCount = countSetting === 'all' ? 5000 : parseInt(countSetting, 10);
  store.saveSettings({ riotId: riotIdRaw, queueFilter, matchCount: countSetting });

  $('analyzeBtn').disabled = true;
  try {
    setProgress('Loading champion / rune / item data…', 0.02);
    [dd, meta] = await Promise.all([
      loadStaticData(),
      meta ? Promise.resolve(meta) : fetch('data/meta.json').then(r => r.json()).catch(() => ({ roles: {} })),
    ]);

    // accounts are global — start on the last known platform (any works) and
    // detect the real one from the account itself
    api = new RiotAPI(store.getApiKey(), store.getSettings().region || 'euw1');

    setProgress('Finding account…', 0.04);
    account = await api.getAccountByRiotId(m[1].trim(), m[2].trim());

    setProgress('Detecting region…', 0.05);
    try {
      const shard = await api.getActiveRegion(account.puuid);
      if (shard?.region) api.setPlatform(String(shard.region).toLowerCase());
    } catch (e) {
      console.warn('Region detection failed, using fallback:', e);
    }
    store.saveSettings({ region: api.platform });

    setProgress('Fetching rank & profile…', 0.06);
    [summoner, leagueEntries] = await Promise.all([
      api.getSummoner(account.puuid).catch(() => null),
      api.getLeagueEntries(account.puuid).catch(() => []),
    ]);

    // Pull previously synced data from GitHub so we don't refetch those matches
    const token = store.getGithubToken();
    let gistId = store.getSettings().gistId || null;
    if (token) {
      try {
        setProgress('Loading saved data from GitHub…', 0.08);
        gistId = await gist.ensureGist(token, gistId);
        store.saveSettings({ gistId });
        const saved = await gist.loadAccountData(token, gistId, account.puuid);
        if (saved?.records) {
          const map = importedCache[account.puuid] ??= {};
          for (const r of saved.records) map[r.id] ??= r;
        }
      } catch (e) {
        console.warn('GitHub sync load failed:', e);
      }
    }

    setProgress('Fetching match list…', 0.1);
    const idOpts = queueFilter === 'ranked-solo' ? { queue: 420 }
                 : queueFilter === 'ranked-all' ? { type: 'ranked' }
                 : {};
    const ids = [];
    for (let start = 0; start < maxCount; start += 100) {
      const want = Math.min(100, maxCount - start);
      const batch = await api.getMatchIds(account.puuid, { ...idOpts, start, count: want });
      ids.push(...batch);
      setProgress(`Fetching match list… ${ids.length} found`, 0.1);
      if (batch.length < want) break;
    }
    if (!ids.length) throw new Error('No matches found for this account with the chosen filter.');

    const mem = importedCache[account.puuid] || {};
    const cached = id => mem[id] || store.getCachedRecord(account.puuid, id);
    const uncachedTotal = ids.filter(id => !cached(id)).length;

    records = [];
    let fetchedCount = 0;
    const t0 = Date.now();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let rec = cached(id);
      if (!rec) {
        const match = await api.getMatch(id);
        rec = extractRecord(match, account.puuid);
        if (rec) store.cacheRecord(account.puuid, id, rec);
        fetchedCount++;
      }
      if (rec) {
        records.push(rec);
        (importedCache[account.puuid] ??= {})[id] = rec;
      }
      let eta = '';
      if (fetchedCount > 5) {
        const avg = (Date.now() - t0) / fetchedCount;
        const leftMs = (uncachedTotal - fetchedCount) * avg;
        if (leftMs > 60000) eta = ` · ~${Math.ceil(leftMs / 60000)} min left`;
      }
      setProgress(`Analyzing matches… ${i + 1}/${ids.length}` +
        (i + 1 - fetchedCount > 0 ? ` (${i + 1 - fetchedCount} from cache)` : '') + eta,
        0.12 + 0.86 * (i + 1) / ids.length);
    }

    agg = aggregate(records);
    if (!agg.totalGames) throw new Error('No Summoner\'s Rift games found in this range — ARAM/Arena are not analyzed. Try "All SR games" or more matches.');

    renderAll();
    hideProgress();
    $('welcome').classList.add('hidden');
    $('app').classList.remove('hidden');

    // Sync to GitHub immediately (non-blocking)
    if (token && gistId) syncToGist(token, gistId);
  } catch (e) {
    hideProgress();
    showError(e instanceof RiotAPIError ? e.message : (e.message || String(e)));
  } finally {
    $('analyzeBtn').disabled = false;
  }
}

async function syncToGist(token, gistId) {
  const el = $('syncStatus');
  try {
    el.textContent = '☁️ Syncing to GitHub…';
    const payload = exportPayload();
    await gist.saveAccountData(token, gistId, account.puuid, payload);
    el.textContent = `☁️ Synced ${payload.records.length} matches to GitHub ✅`;
  } catch (e) {
    el.textContent = `☁️ GitHub sync failed: ${e.message}`;
  }
}

function renderAll() {
  expandedMatchId = null;
  poolExpanded = null;
  poolShowAll = false;
  profileShowAll = false;
  live = null;
  renderSummary();
  renderCounterTab();
  renderProfile();
  renderNemesis();
  renderMatchups();
  $('liveResults').innerHTML = '';
}

// ---------- Summary (account header — merged with the old Profile header card) ----------
function renderSummary() {
  const v = dd.version;
  const iconUrl = summoner?.profileIconId != null
    ? `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/${summoner.profileIconId}.png` : '';

  const wr = agg.totalWins / agg.totalGames;
  const wrCls = wr >= 0.52 ? 'good' : wr <= 0.48 ? 'bad' : 'mid';
  const mains = Object.entries(agg.champStats).sort((a, b) => b[1].games - a[1].games).slice(0, 3);

  // most played role across all analyzed games
  const roleCount = {};
  for (const cs of Object.values(agg.champStats)) {
    for (const [r, rs] of Object.entries(cs.roles)) roleCount[r] = (roleCount[r] || 0) + rs.games;
  }
  const topRole = Object.entries(roleCount).sort((a, b) => b[1] - a[1])[0]?.[0];

  const rankCard = (label, entry) => {
    if (!entry) return `<div class="rank-card unranked">
      <div class="rank-crest">—</div>
      <div><div class="rank-queue">${label}</div><div class="rank-tier muted">Unranked</div></div></div>`;
    const games = entry.wins + entry.losses;
    const rwr = games ? entry.wins / games : 0;
    const t = entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase();
    return `<div class="rank-card">
      <img class="rank-crest" src="${crestUrl(entry.tier)}" alt="${t}"/>
      <div>
        <div class="rank-queue">${label}</div>
        <div class="rank-tier">${t} ${entry.rank} · <b>${entry.leaguePoints} LP</b></div>
        <div class="rank-wl"><span class="wr ${rwr >= 0.52 ? 'good' : rwr <= 0.48 ? 'bad' : 'mid'}">${Math.round(rwr * 100)}%</span>
          <span class="muted">${entry.wins}W ${entry.losses}L</span></div>
      </div></div>`;
  };
  const solo = leagueEntries.find(e => e.queueType === 'RANKED_SOLO_5x5');
  const flex = leagueEntries.find(e => e.queueType === 'RANKED_FLEX_SR');

  $('summaryCard').innerHTML = `
    ${iconUrl ? `<div class="profile-icon-wrap">
      <img class="profile-icon" src="${iconUrl}" alt=""/>
      ${summoner?.summonerLevel != null ? `<span class="lvl-badge">${summoner.summonerLevel}</span>` : ''}
    </div>` : ''}
    <div class="summary-main">
      <div class="big">${account.gameName}<span class="muted">#${account.tagLine}</span></div>
      <div class="summary-sub">
        <span class="wr ${wrCls}">${Math.round(wr * 100)}%</span><span class="muted">winrate</span>
        <span class="sub-sep">·</span>
        ${mains.map(([c]) => {
          const ch = champOf(c);
          return `<img class="champ-mini" src="${ch.icon}" alt="${ch.name}" title="${ch.name} — ${agg.champStats[c].games} games"/>`;
        }).join('')}
        ${topRole ? `<span class="sub-sep">·</span>${roleIcon(topRole)}` : ''}
      </div>
      <div class="stat" id="syncStatus"></div>
    </div>
    <div class="rank-cards">
      ${rankCard('Ranked Solo/Duo', solo)}
      ${rankCard('Ranked Flex', flex)}
    </div>
  `;
}

function crestUrl(tier) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tier.toLowerCase()}.svg`;
}

// ---------- Profile tab ----------
function renderProfile() {
  const recent = [...records].sort((a, b) => b.ts - a.ts);
  const last20 = recent.slice(0, 20);
  const wins20 = last20.filter(r => r.win).length;
  const k = last20.reduce((s, r) => s + r.k, 0), d = last20.reduce((s, r) => s + r.d, 0), a = last20.reduce((s, r) => s + r.a, 0);

  $('profileResults').innerHTML = `
    <div class="panel">
      <h2>Recent games <span class="muted" style="font-weight:400;font-size:0.75em">
        last ${last20.length}: ${wins20}W ${last20.length - wins20}L (${last20.length ? Math.round(wins20 / last20.length * 100) : 0}%)
        · KDA ${(d === 0 ? k + a : (k + a) / d).toFixed(2)} · click a game for details</span></h2>
      <div class="filter-row">
        <input id="profileSearch" type="text" placeholder="Filter games by champion or player name…" autocomplete="off" />
      </div>
      <div class="match-list" id="matchList"></div>
      <div id="moreMatchesSlot"></div>
    </div>`;

  $('profileSearch').oninput = renderMatchList;
  renderMatchList();
}

function renderMatchList() {
  const q = ($('profileSearch')?.value || '').toLowerCase().trim();
  let recent = [...records].sort((a, b) => b.ts - a.ts);
  if (q) {
    recent = recent.filter(r =>
      champOf(r.champ).name.toLowerCase().includes(q) ||
      r.participants.some(p =>
        champOf(p.champ).name.toLowerCase().includes(q) ||
        (p.name || '').toLowerCase().includes(q)));
  }
  const shown = (profileShowAll || q) ? recent : recent.slice(0, 25);
  $('matchList').innerHTML = shown.length
    ? shown.map(matchCard).join('')
    : '<p class="muted">No games match this filter.</p>';
  $('moreMatchesSlot').innerHTML = (!profileShowAll && !q && recent.length > 25)
    ? `<button id="moreMatchesBtn" class="btn ghost" style="margin-top:10px">Show all ${recent.length} games</button>` : '';

  $('matchList').querySelectorAll('.match-card > .match-row').forEach(row => {
    row.onclick = () => {
      const id = row.parentElement.dataset.mid;
      expandedMatchId = expandedMatchId === id ? null : id;
      renderMatchList();
    };
  });
  const moreBtn = $('moreMatchesBtn');
  if (moreBtn) moreBtn.onclick = () => { profileShowAll = true; renderMatchList(); };

  // lazily fetch ranks for the expanded game's players
  if (expandedMatchId) {
    const r = records.find(x => x.id === expandedMatchId);
    if (r) loadRanks(r);
  }
}

// ---------- Per-player rank lookup (league-v4, cached per session) ----------
const rankCache = new Map();   // puuid -> league entry | null
const rankPending = new Set();

async function loadRanks(r) {
  if (!api) return;
  const need = r.participants.filter(p => p.puuid && !rankCache.has(p.puuid) && !rankPending.has(p.puuid));
  if (!need.length) return;
  need.forEach(p => rankPending.add(p.puuid));
  await Promise.all(need.map(async p => {
    try {
      const entries = await api.getLeagueEntries(p.puuid);
      rankCache.set(p.puuid,
        entries.find(e => e.queueType === 'RANKED_SOLO_5x5') ||
        entries.find(e => e.queueType === 'RANKED_FLEX_SR') || null);
    } catch {
      rankCache.set(p.puuid, null);
    } finally {
      rankPending.delete(p.puuid);
    }
  }));
  if (expandedMatchId === r.id) renderMatchList(); // fill the badges in
}

const TIER_ABBR = {
  IRON: 'I', BRONZE: 'B', SILVER: 'S', GOLD: 'G', PLATINUM: 'P', EMERALD: 'E',
  DIAMOND: 'D', MASTER: 'M', GRANDMASTER: 'GM', CHALLENGER: 'C',
};
const DIV_NUM = { I: '1', II: '2', III: '3', IV: '4' };

function rankBadge(p) {
  if (!p.puuid) return '';
  if (!rankCache.has(p.puuid)) {
    return rankPending.has(p.puuid) ? '<span class="rank-line muted">…</span>' : '';
  }
  const e = rankCache.get(p.puuid);
  if (!e) return '<span class="rank-line muted">Unranked</span>';
  const label = `${TIER_ABBR[e.tier] || e.tier[0]}${DIV_NUM[e.rank] || ''}`;
  return `<span class="rank-line" title="${e.tier} ${e.rank} · ${e.leaguePoints} LP">
    <img src="${crestUrl(e.tier)}" alt=""/>${label}</span>`;
}

function myParticipant(r) {
  return r.participants.find(p => p.me)
      || r.participants.find(p => p.team === r.myTeam && p.champ === r.champ);
}

function matchCard(r) {
  const c = champOf(r.champ);
  const mine = myParticipant(r);
  const items = (mine?.items || []).map(id => {
    const it = dd.items[id];
    return it ? `<img src="${it.icon}" title="${it.name}" alt="" loading="lazy"/>` : '';
  }).join('');
  const mm = Math.floor(r.dur / 60);
  const kdaVal = r.d === 0 ? r.k + r.a : (r.k + r.a) / r.d;
  const expanded = expandedMatchId === r.id;
  return `<div class="match-card${expanded ? ' expanded' : ''}" data-mid="${r.id}">
    <div class="match-row ${r.win ? 'won' : 'lost'}">
      <div class="m-result">${r.win ? 'WIN' : 'LOSS'}<span class="muted">${QUEUE_NAMES[r.queue] || 'Other'}</span></div>
      <img class="m-champ" src="${c.icon}" alt="" loading="lazy"/>
      <div class="m-info">
        <b>${c.name}</b>
        <span>${roleIcon(r.pos)}</span>
      </div>
      <div class="m-kda"><b>${r.k} / ${r.d} / ${r.a}</b><span class="muted">${kdaVal.toFixed(2)} KDA</span></div>
      <div class="m-items">${items}</div>
      <div class="m-meta"><span>${mm}m</span><span class="muted">${timeAgo(r.ts)}</span></div>
    </div>
    ${expanded ? matchDetail(r) : ''}
  </div>`;
}

function matchDetail(r) {
  const mine = myParticipant(r);
  const rich = r.participants.some(p => p.k !== undefined);
  const date = new Date(r.ts).toLocaleString();
  const mm = Math.floor(r.dur / 60), ss = r.dur % 60;

  // my runes: keystone + every selected perk + tree pair
  let runesHtml = '';
  if (mine) {
    const s1 = dd.styles[mine.primaryStyle], s2 = dd.styles[mine.subStyle];
    const perkImgs = (mine.runes || []).map(id => {
      const p = dd.perks[id];
      return p ? `<img src="${p.icon}" title="${p.name}" alt="" loading="lazy"/>` : '';
    }).join('');
    if (perkImgs || (s1 && s2)) {
      runesHtml = `<div class="detail-runes"><span class="muted">Your runes:</span>${perkImgs}
        ${s1 && s2 ? `<span class="muted">(${s1.name} + ${s2.name})</span>` : ''}</div>`;
    }
  }

  const maxDmg = Math.max(...r.participants.map(p => p.dmg || 0), 1);
  // one shared table for both teams so all columns stay aligned
  const teamRows = (teamId, label) => {
    const ps = r.participants.filter(p => p.team === teamId);
    const won = ps[0]?.win;
    return `<tr class="team-head"><td colspan="8" class="${won ? 'team-win' : 'team-loss'}">${label} — ${won ? 'Victory' : 'Defeat'}</td></tr>
      ${ps.map(p => participantRow(p, p === mine, r.dur, maxDmg)).join('')}`;
  };
  const enemyTeam = r.myTeam === 100 ? 200 : 100;

  return `<div class="match-detail">
    <div class="detail-meta">
      <b>${QUEUE_NAMES[r.queue] || `Queue ${r.queue}`}</b> · ${date} · ${mm}m ${ss}s
      ${r.pos ? ` · ${roleIcon(r.pos)}` : ''}
      ${!rich ? '<div class="insight warn" style="margin-top:8px">Only basic stats are cached for this game — clear cached matches (🔑 settings) and re-analyze to fetch full details.</div>' : ''}
    </div>
    ${runesHtml}
    <table class="detail-table"><thead><tr>
      <th>Champion</th><th>Player</th><th>KDA</th><th>CS</th><th>Gold</th><th>Dmg</th><th>Vision</th><th>Items</th>
    </tr></thead><tbody>
      ${teamRows(r.myTeam, 'Your team')}
      ${teamRows(enemyTeam, 'Enemy team')}
    </tbody></table>
  </div>`;
}

function participantRow(p, isMe, dur, maxDmg) {
  const c = champOf(p.champ);
  const ks = dd.perks[p.keystone];
  const items = (p.items || []).map(id => {
    const it = dd.items[id];
    return it ? `<img src="${it.icon}" title="${it.name}" alt="" loading="lazy"/>` : '';
  }).join('');
  const dash = '<span class="muted">—</span>';
  const num = v => v !== undefined ? v : dash;

  // KDA: raw line + calculated value, colored u.gg-style (gold ≥5, blue ≥3)
  let kdaCell = dash;
  if (p.k !== undefined) {
    const v = p.d === 0 ? p.k + p.a : (p.k + p.a) / p.d;
    const cls = v >= 5 ? 'kda-gold' : v >= 3 ? 'kda-blue' : 'muted';
    kdaCell = `<b>${p.k}/${p.d}/${p.a}</b><span class="kda-calc ${cls}">${v.toFixed(2)}</span>`;
  }

  // CS + CS per minute underneath
  const csCell = p.cs !== undefined
    ? `<span>${p.cs}</span><span class="muted cs-min">${(p.cs / (dur / 60)).toFixed(1)}/m</span>`
    : dash;

  // damage bar normalized to the game's highest damage dealer
  const dmgCell = p.dmg !== undefined
    ? `<div class="dmg-cell"><span>${(p.dmg / 1000).toFixed(1)}k</span>
        <span class="dmg-bar"><i style="width:${Math.round((p.dmg / maxDmg) * 100)}%"></i></span></div>`
    : dash;

  return `<tr class="${isMe ? 'me-row' : ''}">
    <td><span class="champ-cell small detail-champ">
      <span class="champ-icon-wrap"><img src="${c.icon}" alt="" loading="lazy"/>${p.lvl !== undefined ? `<span class="lvl-corner">${p.lvl}</span>` : ''}</span>${ks ? `<img class="ks-icon" src="${ks.icon}" title="${ks.name}" alt=""/>` : ''}${c.name}
    </span></td>
    <td class="muted detail-player"><div>${p.name || '—'}</div>${rankBadge(p)}</td>
    <td class="kda-cell">${kdaCell}</td>
    <td class="cs-cell">${csCell}</td>
    <td>${p.gold !== undefined ? `${(p.gold / 1000).toFixed(1)}k` : dash}</td>
    <td>${dmgCell}</td>
    <td>${num(p.vision)}</td>
    <td><div class="m-items">${items}</div></td>
  </tr>`;
}

// ---------- Counter Finder ----------
function setupChampSearch(input, box, onPick) {
  let focused = -1;
  const render = () => {
    if (!dd) return;
    const found = searchChampions(dd, input.value);
    if (!found.length) { box.classList.add('hidden'); return; }
    box.innerHTML = found.map((c, i) =>
      `<div data-id="${c.id}" class="${i === focused ? 'focused' : ''}"><img src="${c.icon}" alt=""/>${c.name}</div>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('div').forEach(el => {
      el.onmousedown = e => { e.preventDefault(); onPick(dd.byId[el.dataset.id]); box.classList.add('hidden'); };
    });
  };
  input.addEventListener('input', () => { focused = -1; render(); });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(() => box.classList.add('hidden'), 150));
  input.addEventListener('keydown', e => {
    const found = dd ? searchChampions(dd, input.value) : [];
    if (e.key === 'ArrowDown') { focused = Math.min(focused + 1, found.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { focused = Math.max(focused - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && found.length) {
      onPick(found[Math.max(focused, 0)]); box.classList.add('hidden'); e.preventDefault();
    }
  });
}

function addEnemy(champId) {
  if (!enemyPicks.includes(champId) && enemyPicks.length < 5) {
    enemyPicks.push(champId);
    poolSort = { key: 'score', dir: -1 }; // re-rank the pool against the new pick
    renderCounterTab();
  }
}

function renderCounterTab() {
  if (!agg) return;
  const role = roleVal('myRole');

  $('enemyChips').innerHTML = enemyPicks.map(id => {
    const c = champOf(id);
    return `<span class="chip"><img src="${c.icon}" alt=""/>${c.name}
      <button data-id="${id}" title="Remove">✕</button></span>`;
  }).join('');
  $('enemyChips').querySelectorAll('button').forEach(b => {
    b.onclick = () => { enemyPicks = enemyPicks.filter(x => x !== b.dataset.id); renderCounterTab(); };
  });

  renderPool();

  // Meta gaps (excluding enemy picks)
  const taken = new Set(enemyPicks.map(x => x.toLowerCase()));
  const gaps = metaGaps(meta, agg, role).filter(g => !taken.has(g.id.toLowerCase())).slice(0, 10);
  $('metaResults').innerHTML = !gaps.length
    ? '<p class="muted">Nothing to suggest — you already play the meta picks for this role. 💪</p>'
    : `<table><thead><tr><th>Champion</th><th>Role</th><th>Why it's strong</th><th>Your games</th></tr></thead><tbody>` +
      gaps.map(g => `<tr>
        <td>${champCell(g.id)}</td>
        <td>${roleIcon(g.role) || g.role}</td>
        <td class="muted">${g.why}</td>
        <td>${g.playedGames === 0 ? '<span class="badge gold">NEW</span>' : `${g.playedGames}g`}</td>
      </tr>`).join('') + '</tbody></table>';
}

// ---------- Champion Pool (merged with Counter Finder) & nemesis ----------
function renderPool() {
  if (!agg) return;
  const role = roleVal('myRole');
  const minGames = parseInt($('poolMinGames').value, 10) || 1;
  const taken = new Set(enemyPicks.map(x => x.toLowerCase()));
  const showEvidence = enemyPicks.length > 0;

  // pick scores from the counter engine (your winrate vs the picked enemies + comfort)
  const scores = {};
  for (const s of suggestCounters(agg, enemyPicks, role)) scores[s.champ] = s;

  const data = Object.entries(agg.champStats).map(([champ, s]) => ({
    champ, s,
    games: s.games,
    wr: winrate(s),
    kdaVal: kda(s),
    score: scores[champ]?.score ?? 0,
    sugg: scores[champ],
  })).filter(d =>
    d.games >= minGames &&
    (!role || d.s.roles[role]?.games) &&
    !taken.has(d.champ.toLowerCase()));
  data.sort((a, b) => -poolSort.dir * (b[poolSort.key] - a[poolSort.key]) || b.games - a.games);

  const shown = poolShowAll ? data : data.slice(0, POOL_LIMIT);
  const bestScore = showEvidence && data.length ? Math.max(...data.map(d => d.score)) : null;
  const colSpan = showEvidence ? 7 : 6;

  const rows = shown.map(d => {
    const { s } = d;
    const roles = Object.entries(s.roles).sort((a, b) => b[1].games - a[1].games)
      .map(([r, rs]) => `<span class="role-stat">${roleIcon(r) || r}${rs.games}g</span>`).join('');
    const scoreCell = `<span class="wr ${d.score >= 0.55 ? 'good' : d.score <= 0.45 ? 'bad' : 'mid'}">
      ${d.score === bestScore ? '⭐ ' : ''}${Math.round(d.score * 100)}</span>` +
      (d.sugg?.evidenceGames ? ` <span class="badge blue">${d.sugg.evidenceGames}g vs picks</span>` : '');
    const evidenceCell = showEvidence
      ? `<td class="muted evidence-cell">${d.sugg?.notes?.length ? d.sugg.notes.join(' · ') : 'no history vs picks — comfort only'}</td>`
      : '';
    const expanded = poolExpanded === d.champ;
    return `<tr class="pool-row${expanded ? ' expanded' : ''}" data-champ="${d.champ}" title="Click for builds & runes">
      <td>${champCell(d.champ)}</td>
      <td>${scoreCell}</td>
      ${evidenceCell}
      <td><b>${d.games}</b></td>
      <td>${wrSpan(d.wr, null)}</td>
      <td>${kdaSpan(d.kdaVal)}</td>
      <td class="muted">${roles || '—'}</td>
    </tr>` + (expanded ? `<tr class="pool-detail"><td colspan="${colSpan}">${buildHtml(d.champ)}</td></tr>` : '');
  }).join('');

  $('poolResults').innerHTML = !data.length
    ? '<p class="muted">No champions pass the current filters — analyze more games or relax the filters.</p>'
    : `<table><thead><tr>
      <th>Champion</th>
      ${sortTh(poolSort, 'score', 'Pick score', 'Your winrate vs the picked enemies blended with your comfort on the champ')}
      ${showEvidence ? '<th>Evidence vs picks</th>' : ''}
      ${sortTh(poolSort, 'games', 'Games')}
      ${sortTh(poolSort, 'wr', 'Winrate')}
      ${sortTh(poolSort, 'kdaVal', 'KDA')}
      <th>Roles</th>
    </tr></thead><tbody>${rows}</tbody></table>` +
    (data.length > POOL_LIMIT
      ? `<button id="poolMoreBtn" class="btn ghost" style="margin-top:10px">
          ${poolShowAll ? `Show top ${POOL_LIMIT} only` : `Show all ${data.length} champions you've played`}</button>`
      : '');

  bindSortHeaders($('poolResults'), poolSort, renderPool);
  $('poolResults').querySelectorAll('tr.pool-row').forEach(tr => {
    tr.onclick = () => {
      poolExpanded = poolExpanded === tr.dataset.champ ? null : tr.dataset.champ;
      renderPool();
    };
  });
  const poolMoreBtn = $('poolMoreBtn');
  if (poolMoreBtn) poolMoreBtn.onclick = () => { poolShowAll = !poolShowAll; renderPool(); };
}

function renderNemesis() {

  const nem = Object.entries(agg.vsEnemy)
    .filter(([, s]) => s.games >= 3)
    .sort((a, b) => winrate(a[1]) - winrate(b[1]))
    .slice(0, 12)
    .map(([champ, s]) => `<tr>
      <td>${champCell(champ)}</td>
      <td>${wrSpan(winrate(s), s.games)}</td>
      <td>${winrate(s) < 0.4 ? '<span class="badge red">NEMESIS</span>' : ''}</td>
    </tr>`).join('');
  $('nemesisResults').innerHTML = nem
    ? `<table><thead><tr><th>Enemy champion</th><th>Your winrate when facing</th><th></th></tr></thead><tbody>${nem}</tbody></table>`
    : '<p class="muted">Not enough data yet.</p>';
}

// ---------- Matchups ----------
function renderMatchups() {
  if (!agg) return;
  const q = $('muSearch').value.toLowerCase().trim();
  const role = roleVal('muRole');
  const minGames = parseInt($('muMinGames').value, 10) || 1;

  const all = Object.entries(agg.matchups).map(([key, s]) => {
    const [mine, theirs] = key.split('|');
    return { mine, theirs, s, games: s.games, wr: winrate(s) };
  });
  const filtered = all.filter(m =>
    m.games >= minGames &&
    (!role || m.s.pos === role) &&
    (!q || champOf(m.mine).name.toLowerCase().includes(q) || champOf(m.theirs).name.toLowerCase().includes(q)));
  filtered.sort((a, b) => -muSort.dir * (b[muSort.key] - a[muSort.key]) || b.games - a.games);

  const rows = filtered.map(m => `<tr>
      <td>${champCell(m.mine, true)}</td>
      <td class="muted">vs</td>
      <td>${champCell(m.theirs, true)}</td>
      <td>${roleIcon(m.s.pos) || m.s.pos}</td>
      <td><b>${m.games}</b></td>
      <td>${wrSpan(m.wr, null)}</td>
    </tr>`).join('');

  $('matchupResults').innerHTML = rows
    ? `<table><thead><tr>
        <th>You</th><th></th><th>Lane opponent</th><th>Lane</th>
        ${sortTh(muSort, 'games', 'Games')}
        ${sortTh(muSort, 'wr', 'Winrate')}
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="muted" style="margin-top:10px">${filtered.length} of ${all.length} matchups shown</p>`
    : all.length
      ? '<p class="muted">No matchups pass the current filters.</p>'
      : '<p class="muted">No lane matchup data — positions are only recorded in Summoner\'s Rift games.</p>';

  bindSortHeaders($('matchupResults'), muSort, renderMatchups);
}

// ---------- Builds & Runes ----------
function buildHtml(champId) {
  const b = buildStats(records, champId);
  const c = champOf(champId);
  if (!b.samples) {
    return `<p class="muted" style="margin-top:12px">
      No one played <b>${c.name}</b> in the ${records.length} analyzed matches. Analyze more games or pick another champion.</p>`;
  }
  const itemHtml = b.items.map(it => {
    const item = dd.items[it.key];
    if (!item || item.consumable || item.trinket) return '';
    return `<div class="item-cell"><img src="${item.icon}" title="${item.name}" alt="${item.name}"/>
      <span class="freq">${it.games}g · ${Math.round((it.wins / it.games) * 100)}%</span></div>`;
  }).join('');
  const keystoneHtml = b.keystones.map(k => {
    const p = dd.perks[k.key];
    return p ? `<div class="rune-cell"><img src="${p.icon}" alt=""/>${p.name}
      <span class="muted">${k.games}g · ${Math.round((k.wins / k.games) * 100)}%</span></div>` : '';
  }).join('');
  const treeHtml = b.trees.map(t => {
    const [p1, p2] = t.key.split('|');
    const s1 = dd.styles[p1], s2 = dd.styles[p2];
    return (s1 && s2) ? `<div class="rune-cell"><img src="${s1.icon}" alt=""/>${s1.name}
      <span class="muted">+</span> <img src="${s2.icon}" alt=""/>${s2.name}
      <span class="muted">${t.games}g</span></div>` : '';
  }).join('');

  return `<div class="build-card">
    <div class="champ-cell"><img src="${c.icon}" alt=""/>${c.name}
      <span class="badge blue">${b.samples} games observed</span>
      <span class="badge ${b.sampleWins / b.samples >= 0.5 ? 'gold' : 'grey'}">${Math.round((b.sampleWins / b.samples) * 100)}% won</span>
    </div>
    <div class="build-section"><h4>Keystone</h4><div class="rune-row">${keystoneHtml || '<span class="muted">n/a</span>'}</div></div>
    <div class="build-section"><h4>Rune trees</h4><div class="rune-row">${treeHtml || '<span class="muted">n/a</span>'}</div></div>
    <div class="build-section"><h4>Most successful items</h4><div class="item-row">${itemHtml || '<span class="muted">n/a</span>'}</div></div>
    <p class="muted">Aggregated from every player of ${c.name} across your analyzed matches, weighted ×2 toward wins.</p>
  </div>`;
}

// ---------- Live game ----------
const LANE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

async function checkLiveGame() {
  if (!api || !account) return showError('Analyze your account first.');
  hideError();
  $('liveBtn').disabled = true;
  $('liveResults').innerHTML = '<p class="muted" style="margin-top:12px">Checking…</p>';
  try {
    const game = await api.getActiveGame(account.puuid);
    if (!game) {
      live = null;
      $('liveResults').innerHTML = `<div class="insight warn" style="margin-top:14px">
        Not in a live game right now. The spectator API only works once the game has <b>started</b> —
        during champ select, use the 🎯 Counter Finder tab instead.</div>`;
      return;
    }
    const me = game.participants.find(p => p.puuid === account.puuid);
    const myTeam = me ? me.teamId : 100;
    live = {
      game,
      myTeam,
      allies: game.participants.filter(p => p.teamId === myTeam),
      enemies: game.participants.filter(p => p.teamId !== myTeam),
    };
    renderLiveGame();
  } catch (e) {
    $('liveResults').innerHTML = '';
    showError(e instanceof RiotAPIError ? e.message : (e.message || String(e)));
  } finally {
    $('liveBtn').disabled = false;
  }
}

function liveRate(label, wr, games) {
  const pct = Math.round(wr * 100);
  const cls = pct >= 55 ? 'good' : pct <= 45 ? 'bad' : 'mid';
  return `<span class="live-rate"><span class="muted">${label}</span>
    <b class="wr ${cls}">${pct}%</b> <span class="muted">(${games}g)</span></span>`;
}

function renderLiveGame() {
  const { game, allies, enemies } = live;
  const isSR = SR_QUEUES.has(game.gameQueueConfigId);
  const myIdx = allies.findIndex(p => p.puuid === account.puuid);
  const myChamp = myIdx >= 0 ? dd.byKey[allies[myIdx].championId] : null;

  const teamRow = (p, i, list, side) => {
    const c = dd.byKey[p.championId];
    const name = p.riotId || '';
    const isMe = p.puuid === account.puuid;
    const lane = isSR && list.length === 5 ? `<span class="lane-tag">${ROLE_LABEL[LANE_ORDER[i]]}</span>` : '';

    const rates = [];
    if (c) {
      if (side === 'allies') {
        if (isMe) {
          const s = agg.champStats[c.id];
          if (s?.games) rates.push(liveRate('you on this champ', winrate(s), s.games));
        } else {
          const w = agg.withAlly[c.id];
          if (w?.games >= 2) rates.push(liveRate('win with this ally', winrate(w), w.games));
        }
      } else {
        const v = agg.vsEnemy[c.id];
        if (v?.games >= 2) rates.push(liveRate('win vs', winrate(v), v.games));
        // the enemy aligned with my slot is treated as my lane opponent
        if (isSR && i === myIdx && myChamp && !isMe) {
          const m = agg.matchups[`${myChamp.id}|${c.id}`];
          if (m?.games) rates.push(liveRate('in lane', winrate(m), m.games));
        }
      }
    }

    const arrows = `<span class="order-btns">
      <button class="order-btn" data-side="${side}" data-i="${i}" data-dir="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="order-btn" data-side="${side}" data-i="${i}" data-dir="1" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
    </span>`;

    return `<div class="team-row${isMe ? ' me' : ''}${side === 'enemies' && i === myIdx && isSR ? ' my-lane' : ''}">
      ${arrows}${lane}${c ? `<img src="${c.icon}" alt=""/>` : ''}<b>${c?.name || '?'}</b>
      <span class="muted live-player">${isMe ? 'you' : (name !== c?.name ? name : '')}</span>
      <span class="vs-note">${rates.join('')}</span>
    </div>`;
  };

  // grouped, plain-language insights
  const allyObjs = allies.map(p => dd.byKey[p.championId]).filter(Boolean);
  const enemyObjs = enemies.map(p => dd.byKey[p.championId]).filter(Boolean);
  const insights = [...teamInsights(allyObjs, enemyObjs), ...focusInsights(myChamp, enemyObjs)];
  const SECTION_ICONS = { 'Your team': '🛡️', 'Enemy team': '⚔️', 'Game plan': '🗺️', 'Where to focus': '🎯' };
  const insightHtml = Object.keys(SECTION_ICONS).map(sec => {
    const items = insights.filter(i => i.section === sec);
    if (!items.length) return '';
    return `<div class="insight-group"><h3>${SECTION_ICONS[sec]} ${sec}</h3>
      ${items.map(i => `<div class="insight ${i.type === 'warn' ? 'warn' : i.type === 'ok' ? 'ok' : ''}">${i.text}</div>`).join('')}</div>`;
  }).join('');

  const queueNote = QUEUE_NAMES[game.gameQueueConfigId] || `Queue ${game.gameQueueConfigId}`;
  const mins = Math.floor((game.gameLength > 0 ? game.gameLength : 0) / 60);

  $('liveResults').innerHTML = `
    <div class="insight" style="margin-top:14px">🟢 <b>Live game found</b> — ${queueNote}, ~${mins} min in.</div>
    ${isSR ? `<p class="muted" style="margin-top:8px">Use ▲▼ to match the real lane order (Top → Jungle → Mid → ADC → Support) —
      the enemy in <b>your</b> slot is treated as your lane opponent and the rates update.</p>` : ''}
    <div class="live-teams">
      <div class="team-box ally"><h3>Your team</h3>${allies.map((p, i) => teamRow(p, i, allies, 'allies')).join('')}</div>
      <div class="team-box enemy"><h3>Enemy team</h3>${enemies.map((p, i) => teamRow(p, i, enemies, 'enemies')).join('')}</div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Insights</h2>${insightHtml || '<p class="muted">Not enough data.</p>'}</div>`;

  $('liveResults').querySelectorAll('.order-btn').forEach(btn => {
    btn.onclick = () => {
      const list = live[btn.dataset.side];
      const i = parseInt(btn.dataset.i, 10), j = i + parseInt(btn.dataset.dir, 10);
      [list[i], list[j]] = [list[j], list[i]];
      renderLiveGame();
    };
  });
}

// "Where to focus" — personal history vs this exact lobby
function focusInsights(myChamp, enemyObjs) {
  const out = [];
  for (const c of enemyObjs) {
    const v = agg.vsEnemy[c.id];
    if (v && v.games >= 3 && winrate(v) <= 0.4) {
      out.push({ section: 'Where to focus', type: 'warn',
        text: `<b>Watch out for ${c.name}</b> — you win only ${Math.round(winrate(v) * 100)}% when they're on the enemy team (${v.games}g). Respect them and track where they are.` });
    }
  }
  if (myChamp) {
    const s = agg.champStats[myChamp.id];
    if (s?.games >= 3) {
      const wr = winrate(s);
      if (wr >= 0.55) out.push({ section: 'Where to focus', type: 'ok',
        text: `<b>Comfort pick</b> — you win ${Math.round(wr * 100)}% on ${myChamp.name} (${s.games}g). Play to carry: push your lead and drag the map with you.` });
      else if (wr <= 0.45) out.push({ section: 'Where to focus', type: 'warn',
        text: `<b>Careful on ${myChamp.name}</b> — you win only ${Math.round(wr * 100)}% on it (${s.games}g). Play safe, farm up, and follow your strongest teammate's calls.` });
    }
  }
  return out;
}
