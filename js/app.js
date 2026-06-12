import { RiotAPI, RiotAPIError } from './riotApi.js';
import { loadStaticData, searchChampions } from './ddragon.js';
import { extractRecord, aggregate, buildStats, winrate, kda, SR_QUEUES, REC_VERSION } from './analysis.js';
import { suggestCounters, teamInsights } from './suggest.js';
import * as gist from './gist.js';
import * as store from './store.js';

// ---------- App state ----------
let dd = null;          // static data (champs, runes, items)
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
let cancelAnalysis = false;                 // set by the ✕ next to the progress bar

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

  $('settingsBtn').onclick = () => $('settingsPanel').classList.toggle('hidden');
  $('clearCacheBtn').onclick = () => {
    const n = store.clearMatchCache();
    importedCache = {}; // also drop records loaded from gist sync / file imports this session
    $('cacheStatus').textContent = `Cleared ${n} cached matches from this browser (and any synced/imported data in memory). The next Analyze refetches everything from Riot.`;
  };
  $('exportBtn').onclick = exportData;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = importData;
  $('analyzeBtn').onclick = analyze;
  $('riotId').addEventListener('keydown', e => { if (e.key === 'Enter') analyze(); });
  $('progressCancel').onclick = () => {
    cancelAnalysis = true;
    $('progressLabel').textContent = 'Stopping…';
  };

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
function sortTh(state, key, label, title = '', cls = '') {
  const active = state.key === key;
  return `<th class="sortable${active ? ' sorted' : ''}${cls ? ' ' + cls : ''}" data-key="${key}" ${title ? `title="${title}"` : ''}>
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

  const queueFilter = $('queueFilter').value;
  const countSetting = $('matchCount').value;
  const maxCount = countSetting === 'all' ? 5000 : parseInt(countSetting, 10);
  store.saveSettings({ riotId: riotIdRaw, queueFilter, matchCount: countSetting });

  $('analyzeBtn').disabled = true;
  cancelAnalysis = false;
  try {
    setProgress('Loading champion / rune / item data…', 0.02);
    dd = await loadStaticData();

    api = new RiotAPI();

    setProgress('Finding account…', 0.04);
    account = await api.getAccountByRiotId(m[1].trim(), m[2].trim());

    setProgress('Detecting region…', 0.05);
    const plat = await api.detectPlatform(account.puuid);
    api.setPlatform(plat || store.getSettings().region || 'euw1');
    store.saveSettings({ region: api.platform });

    setProgress('Fetching rank & profile…', 0.06);
    [summoner, leagueEntries] = await Promise.all([
      api.getSummoner(account.puuid).catch(() => null),
      api.getLeagueEntries(account.puuid).catch(() => []),
    ]);

    // Pull previously synced data from GitHub so we don't refetch those matches
    // (server-side token; silently skipped if GitHub sync isn't configured)
    let gistId = store.getSettings().gistId || null;
    try {
      setProgress('Loading saved data from GitHub…', 0.08);
      gistId = await gist.ensureGist(gistId);
      store.saveSettings({ gistId });
      const saved = await gist.loadAccountData(gistId, account.puuid);
      if (saved?.records) {
        const map = importedCache[account.puuid] ??= {};
        for (const r of saved.records) map[r.id] ??= r;
      }
    } catch (e) {
      console.warn('GitHub sync unavailable:', e.message);
      gistId = null;
    }

    setProgress('Fetching match list…', 0.1);
    const idOpts = queueFilter === 'ranked-solo' ? { queue: 420 }
                 : queueFilter === 'ranked-all' ? { type: 'ranked' }
                 : {};
    const fetchIds = async () => {
      const out = [];
      for (let start = 0; start < maxCount; start += 100) {
        if (cancelAnalysis) break;
        const want = Math.min(100, maxCount - start);
        const batch = await api.getMatchIds(account.puuid, { ...idOpts, start, count: want });
        out.push(...batch);
        setProgress(`Fetching match list… ${out.length} found`, 0.1);
        if (batch.length < want) break;
      }
      return out;
    };

    const ids = await fetchIds();
    if (!ids.length) {
      // distinguish "wrong filter" from "no games in this region"
      const any = cancelAnalysis ? [] : await api.getMatchIds(account.puuid, { start: 0, count: 1 }).catch(() => []);
      throw new Error(any.length
        ? 'This account has matches, but none pass the chosen queue filter — switch the dropdown to "All SR games" and try again.'
        : 'No matches found for this account.');
    }

    const mem = importedCache[account.puuid] || {};
    // a cached record only counts if it has the current schema — older ones
    // (from localStorage, gist sync or file import) are refetched with full stats
    const cached = id => {
      const rec = mem[id] || store.getCachedRecord(account.puuid, id);
      return rec && rec.rv === REC_VERSION ? rec : null;
    };
    const uncachedTotal = ids.filter(id => !cached(id)).length;

    records = [];
    let fetchedCount = 0;
    const t0 = Date.now();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let rec = cached(id);
      if (!rec) {
        if (cancelAnalysis) break; // stop hitting the API — analyze what we have
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
    if (!agg.totalGames) {
      throw new Error(cancelAnalysis
        ? 'Analysis stopped before any games were loaded.'
        : 'No Summoner\'s Rift games found in this range — ARAM/Arena are not analyzed. Try "All SR games" or more matches.');
    }

    renderAll();
    hideProgress();
    $('welcome').classList.add('hidden');
    $('app').classList.remove('hidden');

    // Sync to GitHub immediately (non-blocking; only if sync is configured server-side)
    if (gistId) syncToGist(gistId);
  } catch (e) {
    hideProgress();
    showError(e instanceof RiotAPIError ? e.message : (e.message || String(e)));
  } finally {
    $('analyzeBtn').disabled = false;
  }
}

async function syncToGist(gistId) {
  const el = $('syncStatus');
  try {
    el.textContent = '☁️ Syncing to GitHub…';
    const payload = exportPayload();
    await gist.saveAccountData(gistId, account.puuid, payload);
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
  renderClimb();
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

// ---------- Per-player lookups (league, mastery — cached per session) ----------
const rankCache = new Map();      // puuid -> league entry | null
const rankPending = new Set();
const masteryCache = new Map();   // puuid -> top mastery entries
const masteryPending = new Set();
const scoutCache = new Map();     // puuid -> { form: [{win, champ}] } latest first

async function ensureRanks(participants, onDone) {
  if (!api) return;
  const need = participants.filter(p => p.puuid && !rankCache.has(p.puuid) && !rankPending.has(p.puuid));
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
  onDone();
}

async function ensureMasteries(participants, onDone) {
  if (!api) return;
  const need = participants.filter(p => p.puuid && !masteryCache.has(p.puuid) && !masteryPending.has(p.puuid));
  if (!need.length) return;
  need.forEach(p => masteryPending.add(p.puuid));
  await Promise.all(need.map(async p => {
    try {
      masteryCache.set(p.puuid, await api.getTopMasteries(p.puuid, 5));
    } catch {
      masteryCache.set(p.puuid, []);
    } finally {
      masteryPending.delete(p.puuid);
    }
  }));
  onDone();
}

function loadRanks(r) {
  ensureRanks(r.participants, () => { if (expandedMatchId === r.id) renderMatchList(); });
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

function spellStack(p, cls = 'm-spells') {
  const imgs = (p?.spells || []).map(id => {
    const s = dd.spells[id];
    return s ? `<img src="${s.icon}" title="${s.name}" alt="" loading="lazy"/>` : '';
  }).join('');
  return imgs ? `<span class="${cls}">${imgs}</span>` : '';
}

// keystone with the secondary rune tree as a small circle overlapping its right side
function runeStack(p) {
  const ks = dd.perks[p?.keystone];
  if (!ks) return '';
  const sub = dd.styles[p.subStyle];
  return `<span class="rune-wrap">
    <img class="rune-primary" src="${ks.icon}" title="${ks.name}" alt="" loading="lazy"/>
    ${sub ? `<img class="rune-sub" src="${sub.icon}" title="${sub.name}" alt="" loading="lazy"/>` : ''}
  </span>`;
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
      ${spellStack(mine)}
      ${runeStack(mine)}
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
      <span class="champ-icon-wrap"><img src="${c.icon}" alt="" loading="lazy"/>${p.lvl !== undefined ? `<span class="lvl-corner">${p.lvl}</span>` : ''}</span>${spellStack(p, 'detail-spells')}${runeStack(p)}${c.name}
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

  $('enemyChips').innerHTML = enemyPicks.map(id => {
    const c = champOf(id);
    return `<span class="chip"><img src="${c.icon}" alt=""/>${c.name}
      <button data-id="${id}" title="Remove">✕</button></span>`;
  }).join('');
  $('enemyChips').querySelectorAll('button').forEach(b => {
    b.onclick = () => { enemyPicks = enemyPicks.filter(x => x !== b.dataset.id); renderCounterTab(); };
  });

  renderPool();
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
    mkScore: s.mk ? s.mk.d + s.mk.t * 3 + s.mk.q * 10 + s.mk.p * 40 : 0,
    score: scores[champ]?.score ?? 0,
    sugg: scores[champ],
  })).filter(d =>
    d.games >= minGames &&
    (!role || d.s.roles[role]?.games) &&
    !taken.has(d.champ.toLowerCase()));
  data.sort((a, b) => -poolSort.dir * (b[poolSort.key] - a[poolSort.key]) || b.games - a.games);

  const shown = poolShowAll ? data : data.slice(0, POOL_LIMIT);
  const bestScore = showEvidence && data.length ? Math.max(...data.map(d => d.score)) : null;
  // only show the multikill column when there is at least one multikill recorded
  const showMk = data.some(d => d.mkScore > 0);
  const colSpan = 6 + (showEvidence ? 1 : 0) + (showMk ? 1 : 0);

  // compressed double/triple/quadra/penta cell, e.g. "9·3·1·1" with the big ones highlighted
  const mkCell = mk => {
    if (!mk || (!mk.d && !mk.t && !mk.q && !mk.p)) return '<span class="muted">—</span>';
    return `<span class="mk-cell" title="${mk.d} double · ${mk.t} triple · ${mk.q} quadra · ${mk.p} penta">
      <span class="${mk.d ? '' : 'muted'}">${mk.d}</span>·<span class="${mk.t ? '' : 'muted'}">${mk.t}</span>·<span class="${mk.q ? 'mk-quadra' : 'muted'}">${mk.q}</span>·<span class="${mk.p ? 'mk-penta' : 'muted'}">${mk.p}</span>
    </span>`;
  };

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
      <td class="col-center">${scoreCell}</td>
      ${evidenceCell}
      <td class="col-center"><b>${d.games}</b></td>
      <td>${wrSpan(d.wr, null)}</td>
      <td>${kdaSpan(d.kdaVal)}</td>
      ${showMk ? `<td>${mkCell(d.s.mk)}</td>` : ''}
      <td class="muted">${roles || '—'}</td>
    </tr>` + (expanded ? `<tr class="pool-detail"><td colspan="${colSpan}">${buildHtml(d.champ)}</td></tr>` : '');
  }).join('');

  $('poolResults').innerHTML = !data.length
    ? '<p class="muted">No champions pass the current filters — analyze more games or relax the filters.</p>'
    : `<table><thead><tr>
      <th>Champion</th>
      ${sortTh(poolSort, 'score', 'Pick score', 'Your winrate vs the picked enemies blended with your comfort on the champ', 'col-center')}
      ${showEvidence ? '<th>Evidence vs picks</th>' : ''}
      ${sortTh(poolSort, 'games', 'Games', '', 'col-center')}
      ${sortTh(poolSort, 'wr', 'Winrate')}
      ${sortTh(poolSort, 'kdaVal', 'KDA')}
      ${showMk ? sortTh(poolSort, 'mkScore', '2·3·4·5×', 'Double · Triple · Quadra · Penta kills') : ''}
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

// ---------- Climb tab : trends, schedule, tilt, patches ----------
function renderClimb() {
  if (!agg) return;
  const games = records.filter(r => SR_QUEUES.has(r.queue)).sort((a, b) => a.ts - b.ts);
  $('climbResults').innerHTML = `
    <div class="panel"><h2>📈 Winrate trend</h2>${trendChart(games)}</div>
    <div class="panel"><h2>🕐 When you win</h2>
      <p class="muted">Winrate by weekday and time of day — schedule your ranked sessions when you actually win.</p>
      ${whenHtml(games)}</div>
    <div class="panel"><h2>🧠 Tilt check</h2>${tiltHtml(games)}</div>
    <div class="panel"><h2>🩹 Winrate by patch</h2>${patchHtml(games)}</div>`;
}

function trendChart(games) {
  const W = 10; // rolling window
  if (games.length < W + 2) return '<p class="muted">Not enough games for a trend — analyze at least 12.</p>';
  const pts = [];
  let wins = 0;
  for (let i = 0; i < games.length; i++) {
    wins += games[i].win ? 1 : 0;
    if (i >= W) wins -= games[i - W].win ? 1 : 0;
    if (i >= W - 1) pts.push(wins / W);
  }
  const w = 600, h = 150, pad = 8;
  const x = i => pad + i * (w - 2 * pad) / Math.max(pts.length - 1, 1);
  const y = v => h - pad - v * (h - 2 * pad);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="trend-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <line x1="0" y1="${y(0.5).toFixed(1)}" x2="${w}" y2="${y(0.5).toFixed(1)}" class="trend-base"/>
      <polyline points="${line}" class="trend-line"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" class="trend-dot"/>
    </svg>
    <div class="muted" style="margin-top:6px">Rolling ${W}-game winrate across your last ${games.length} SR games
      (oldest → newest, dashed line = 50%). Right now: <b class="wr ${last >= 0.55 ? 'good' : last <= 0.45 ? 'bad' : 'mid'}">${Math.round(last * 100)}%</b>.</div>`;
}

function climbRow(label, s) {
  if (!s.games) return `<div class="clb-row"><span class="clb-label">${label}</span><span class="muted">no games</span></div>`;
  const wr = s.wins / s.games;
  const cls = wr >= 0.55 ? 'good' : wr <= 0.45 ? 'bad' : 'mid';
  return `<div class="clb-row">
    <span class="clb-label">${label}</span>
    <span class="clb-bar"><i class="${cls}" style="width:${Math.round(wr * 100)}%"></i></span>
    <span class="wr ${cls}">${Math.round(wr * 100)}%</span>
    <span class="muted">(${s.games}g)</span>
  </div>`;
}

function whenHtml(games) {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = DAYS.map(() => ({ games: 0, wins: 0 }));
  const TODS = [['🌅 Morning (6–12)', 6, 12], ['☀️ Afternoon (12–18)', 12, 18], ['🌆 Evening (18–24)', 18, 24], ['🌙 Night (0–6)', 0, 6]];
  const tods = TODS.map(() => ({ games: 0, wins: 0 }));
  for (const g of games) {
    const dt = new Date(g.ts);
    const d = days[(dt.getDay() + 6) % 7]; // 0=Mon
    d.games++; if (g.win) d.wins++;
    const h = dt.getHours();
    const ti = TODS.findIndex(([, from, to]) => h >= from && h < to);
    if (ti >= 0) { tods[ti].games++; if (g.win) tods[ti].wins++; }
  }
  return `<div class="clb-cols">
    <div>${DAYS.map((d, i) => climbRow(d, days[i])).join('')}</div>
    <div>${TODS.map(([label], i) => climbRow(label, tods[i])).join('')}</div>
  </div>`;
}

function tiltHtml(games) {
  if (games.length < 10) return '<p class="muted">Not enough games yet.</p>';
  // sessions = games separated by less than an hour of downtime
  const sessions = [];
  let cur = [];
  for (const g of games) {
    const prev = cur[cur.length - 1];
    if (prev && g.ts - (prev.ts + prev.dur * 1000) > 3600e3) { sessions.push(cur); cur = []; }
    cur.push(g);
  }
  if (cur.length) sessions.push(cur);

  const afterWin = { games: 0, wins: 0 }, afterLoss = { games: 0, wins: 0 }, after2 = { games: 0, wins: 0 };
  const early = { games: 0, wins: 0 }, late = { games: 0, wins: 0 };
  for (const s of sessions) {
    s.forEach((g, i) => {
      const slot = i < 3 ? early : late;
      slot.games++; if (g.win) slot.wins++;
      if (i >= 1) { const b = s[i - 1].win ? afterWin : afterLoss; b.games++; if (g.win) b.wins++; }
      if (i >= 2 && !s[i - 1].win && !s[i - 2].win) { after2.games++; if (g.win) after2.wins++; }
    });
  }
  let streak = 0, bestW = 0, bestL = 0;
  for (const g of games) {
    streak = g.win ? Math.max(streak, 0) + 1 : Math.min(streak, 0) - 1;
    bestW = Math.max(bestW, streak); bestL = Math.min(bestL, streak);
  }

  const pct = s => Math.round((s.wins / s.games) * 100);
  const insights = [];
  if (afterWin.games >= 5 && afterLoss.games >= 5) {
    const diff = afterWin.wins / afterWin.games - afterLoss.wins / afterLoss.games;
    if (diff >= 0.08) {
      insights.push(`<div class="insight warn"><b>You tilt.</b> In the same session you win <b>${pct(afterLoss)}%</b> right after a loss
        vs <b>${pct(afterWin)}%</b> after a win (${afterLoss.games}g / ${afterWin.games}g). Take a 5-minute break after every loss before queueing again.</div>`);
    } else {
      insights.push(`<div class="insight ok"><b>No tilt detected</b> — your winrate after a loss (${pct(afterLoss)}%) is about the same as after a win (${pct(afterWin)}%). Keep doing what you're doing.</div>`);
    }
  }
  if (after2.games >= 3 && after2.wins / after2.games <= 0.45) {
    insights.push(`<div class="insight warn"><b>Stop after two losses.</b> When you queue up anyway, you win only
      <b>${pct(after2)}%</b> of those games (${after2.games}g). Two losses in a row = log off, you're statistically donating LP.</div>`);
  }
  if (early.games >= 8 && late.games >= 8) {
    const d = early.wins / early.games - late.wins / late.games;
    if (d >= 0.08) {
      insights.push(`<div class="insight warn"><b>Long sessions hurt you.</b> Games 1–3 of a session: <b>${pct(early)}%</b> winrate.
        Game 4 and beyond: <b>${pct(late)}%</b>. Cap your sessions at three games.</div>`);
    } else if (d <= -0.08) {
      insights.push(`<div class="insight ok"><b>You warm up slowly</b> — you win more from game 4 onward (${pct(late)}%) than in your first three (${pct(early)}%). Consider a norms warm-up game first.</div>`);
    }
  }
  if (!insights.length) insights.push('<p class="muted">Nothing alarming found — need more games in the analyzed window for stronger conclusions.</p>');

  return `${insights.join('')}
    <div class="clb-stats">
      ${afterWin.games ? climbRow('After a win', afterWin) : ''}
      ${afterLoss.games ? climbRow('After a loss', afterLoss) : ''}
      ${after2.games ? climbRow('After 2+ losses', after2) : ''}
      ${climbRow('Session games 1–3', early)}
      ${climbRow('Session games 4+', late)}
    </div>
    <p class="muted" style="margin-top:10px">${sessions.length} sessions detected (new session after a 1h+ break).
      Longest win streak <b class="wr good">${bestW}</b> · longest loss streak <b class="wr bad">${-bestL}</b>.</p>`;
}

function patchHtml(games) {
  const byPatch = {};
  let missing = 0;
  for (const g of games) {
    if (!g.ver) { missing++; continue; }
    const p = byPatch[g.ver] ??= { games: 0, wins: 0 };
    p.games++; if (g.win) p.wins++;
  }
  const patches = Object.entries(byPatch).sort((a, b) => {
    const [a1, a2] = a[0].split('.').map(Number), [b1, b2] = b[0].split('.').map(Number);
    return b1 - a1 || b2 - a2;
  });
  if (!patches.length) {
    return '<p class="muted">No patch info in the cached data — clear cached matches (🔑 settings) and re-analyze once to record patch versions.</p>';
  }
  return patches.map(([ver, s]) => climbRow(`Patch ${ver}`, s)).join('') +
    (missing ? `<p class="muted" style="margin-top:8px">${missing} older cached games have no patch info — clear cached matches and re-analyze to include them.</p>` : '');
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
    // scout the lobby in the background: ranks + champion mastery for all ten players
    const rerender = () => { if (live?.game === game) renderLiveGame(); };
    ensureRanks(game.participants, rerender);
    ensureMasteries(game.participants, rerender);
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
    const laneTag = isSR && list.length === 5 ? `<span class="lp-lane">${ROLE_LABEL[LANE_ORDER[i]]}</span>` : '';

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

    const arrows = `<span class="lp-order">
      <button class="order-btn" data-side="${side}" data-i="${i}" data-dir="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="order-btn" data-side="${side}" data-i="${i}" data-dir="1" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
    </span>`;

    const scout = isMe ? '' : scoutLine(p);
    return `<div class="lp-card${isMe ? ' me' : ''}${side === 'enemies' && i === myIdx && isSR ? ' my-lane' : ''}">
      <div class="lp-head">
        ${arrows}${laneTag}
        ${c ? `<img class="lp-champ" src="${c.icon}" alt=""/>` : '<span class="lp-champ lp-champ-empty"></span>'}
        <span class="lp-id">
          <b>${c?.name || '?'}</b>
          <span class="lp-name muted">${isMe ? 'you' : (name && name !== c?.name ? name : '')}</span>
        </span>
        <span class="lp-rank">${rankBadge(p)}</span>
      </div>
      ${rates.length ? `<div class="lp-rates">${rates.join('')}</div>` : ''}
      ${scout}
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
    ${deepScoutButton()}
    <div class="panel" style="margin-top:16px"><h2>Insights</h2>${insightHtml || '<p class="muted">Not enough data.</p>'}</div>`;

  $('liveResults').querySelectorAll('.order-btn').forEach(btn => {
    btn.onclick = () => {
      const list = live[btn.dataset.side];
      const i = parseInt(btn.dataset.i, 10), j = i + parseInt(btn.dataset.dir, 10);
      [list[i], list[j]] = [list[j], list[i]];
      renderLiveGame();
    };
  });
  const dsBtn = $('deepScoutBtn');
  if (dsBtn) dsBtn.onclick = deepScout;
}

// ---------- Live scouting (mastery mains + recent form) ----------
let scouting = false;
let scoutProgress = '';

function fmtPts(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
}

function scoutLine(p) {
  const bits = [];
  const top = masteryCache.get(p.puuid);
  if (top?.length) {
    const mains = top.slice(0, 3).map(m => {
      const ch = dd.byKey[m.championId];
      return ch ? `<img class="scout-main${m.championId === p.championId ? ' cur' : ''}" src="${ch.icon}"
        title="${ch.name} — ${fmtPts(m.championPoints)} mastery" alt=""/>` : '';
    }).join('');
    bits.push(`<span class="scout-bit"><span class="muted">mains</span> ${mains}</span>`);
    const cur = top.find(m => m.championId === p.championId);
    bits.push(cur
      ? `<span class="scout-bit"><b>${fmtPts(cur.championPoints)}</b> <span class="muted">on this champ</span></span>`
      : `<span class="scout-bit muted">champ not in their top 5</span>`);
  }
  const sc = scoutCache.get(p.puuid);
  if (sc?.form.length) {
    const w = sc.form.filter(f => f.win).length;
    const dots = sc.form.map(f =>
      `<i class="form-dot ${f.win ? 'w' : 'l'}" title="${champOf(f.champ).name} — ${f.win ? 'win' : 'loss'}"></i>`).join('');
    let streak = 0;
    for (const f of sc.form) { if (f.win === sc.form[0].win) streak++; else break; }
    bits.push(`<span class="scout-bit">${dots} ${w}W-${sc.form.length - w}L` +
      (streak >= 3 ? ` <b class="wr ${sc.form[0].win ? 'good' : 'bad'}">${streak}${sc.form[0].win ? 'W' : 'L'} streak</b>` : '') + '</span>');
    const curId = dd.byKey[p.championId]?.id;
    const onChamp = sc.form.filter(f => f.champ === curId).length;
    bits.push(onChamp === 0
      ? `<span class="scout-bit wr bad">⚠ 0 games on this champ in their last ${sc.form.length}</span>`
      : `<span class="scout-bit"><span class="muted">this champ</span> ${onChamp}/${sc.form.length} recent</span>`);
  }
  return bits.length ? `<div class="scout-line">${bits.join('')}</div>` : '';
}

function scoutTargets() {
  if (!live) return [];
  return [...live.allies, ...live.enemies].filter(p => p.puuid && p.puuid !== account.puuid);
}

function deepScoutButton() {
  if (!live) return '';
  const left = scoutTargets().filter(p => !scoutCache.has(p.puuid)).length;
  if (!left && !scouting) return '';
  return `<button id="deepScoutBtn" class="btn ghost" style="margin-top:12px" ${scouting ? 'disabled' : ''}>
    ${scouting ? `🔍 ${scoutProgress}` : `🔍 Deep scout all players — last 8 games each (~1 min on a dev key)`}</button>`;
}

async function deepScout() {
  if (!live || scouting) return;
  scouting = true;
  const targets = scoutTargets().filter(p => !scoutCache.has(p.puuid));
  try {
    for (let t = 0; t < targets.length; t++) {
      const p = targets[t];
      scoutProgress = `Scouting ${dd.byKey[p.championId]?.name || 'enemy'} (${t + 1}/${targets.length})…`;
      if (live) renderLiveGame();
      let ids = await api.getMatchIds(p.puuid, { count: 8, type: 'ranked' }).catch(() => []);
      if (!ids.length) ids = await api.getMatchIds(p.puuid, { count: 8 }).catch(() => []);
      const form = [];
      for (const id of ids) {
        try {
          const match = await api.getMatch(id);
          const mp = match.info.participants.find(x => x.puuid === p.puuid);
          if (mp) form.push({ win: mp.win, champ: mp.championName });
        } catch { /* skip this match */ }
      }
      scoutCache.set(p.puuid, { form });
    }
  } finally {
    scouting = false;
    scoutProgress = '';
    if (live) renderLiveGame();
  }
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
