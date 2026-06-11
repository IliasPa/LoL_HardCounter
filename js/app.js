import { RiotAPI, RiotAPIError } from './riotApi.js';
import { loadStaticData, searchChampions } from './ddragon.js';
import { extractRecord, aggregate, buildStats, winrate, kda, SR_QUEUES } from './analysis.js';
import { suggestCounters, metaGaps, teamNeeds } from './suggest.js';
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

const $ = id => document.getElementById(id);

const QUEUE_NAMES = {
  420: 'Ranked Solo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind',
  490: 'Quickplay', 450: 'ARAM', 700: 'Clash', 1700: 'Arena', 1900: 'URF',
};
const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
const LP_PER_GAME = 25; // rough estimate; Riot's API doesn't expose LP per match

// ---------- Boot ----------
init();

function init() {
  const s = store.getSettings();
  if (s.riotId) $('riotId').value = s.riotId;
  if (s.region) $('region').value = s.region;
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
  setupChampSearch($('buildSearch'), $('buildSuggest'), c => { $('buildSearch').value = c.name; renderBuild(c.id); });
  $('clearEnemiesBtn').onclick = () => { enemyPicks = []; renderCounterTab(); };
  $('myRole').onchange = renderCounterTab;
  $('liveBtn').onclick = checkLiveGame;
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
    account: { puuid: account.puuid, gameName: account.gameName, tagLine: account.tagLine, region: $('region').value },
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
    <span class="wr-bar"><i style="width:${Math.round(wr * 100)}%"></i></span>
    <span class="muted"> (${games}g)</span>`;
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

  const region = $('region').value;
  const queueFilter = $('queueFilter').value;
  const countSetting = $('matchCount').value;
  const maxCount = countSetting === 'all' ? 5000 : parseInt(countSetting, 10);
  store.saveSettings({ riotId: riotIdRaw, region, queueFilter, matchCount: countSetting });

  $('analyzeBtn').disabled = true;
  try {
    setProgress('Loading champion / rune / item data…', 0.02);
    [dd, meta] = await Promise.all([
      loadStaticData(),
      meta ? Promise.resolve(meta) : fetch('data/meta.json').then(r => r.json()).catch(() => ({ roles: {} })),
    ]);

    api = new RiotAPI(store.getApiKey(), region);

    setProgress('Finding account…', 0.04);
    account = await api.getAccountByRiotId(m[1].trim(), m[2].trim());

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
  renderSummary();
  renderCounterTab();
  renderProfile();
  renderPool();
  renderMatchups();
  $('buildResults').innerHTML = '';
  $('liveResults').innerHTML = '';
}

// ---------- Summary ----------
function renderSummary() {
  const wr = agg.totalWins / agg.totalGames;
  const mains = Object.entries(agg.champStats).sort((a, b) => b[1].games - a[1].games).slice(0, 3);
  const solo = leagueEntries.find(e => e.queueType === 'RANKED_SOLO_5x5');
  $('summaryCard').innerHTML = `
    <div class="big">${account.gameName}<span class="muted">#${account.tagLine}</span></div>
    ${solo ? `<div class="stat">${tierBadge(solo)}</div>` : ''}
    <div class="stat">SR games analyzed: <b>${agg.totalGames}</b></div>
    <div class="stat">Winrate: <b>${Math.round(wr * 100)}%</b></div>
    <div class="stat">Most played: ${mains.map(([c, s]) => `<b>${champOf(c).name}</b> (${s.games})`).join(' · ')}</div>
    <div class="stat" id="syncStatus"></div>
  `;
}

function crestUrl(tier) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tier.toLowerCase()}.svg`;
}

function tierBadge(entry) {
  const t = entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase();
  return `<img class="crest-mini" src="${crestUrl(entry.tier)}" alt=""/> <b>${t} ${entry.rank}</b> · ${entry.leaguePoints} LP`;
}

// ---------- Profile tab ----------
function renderProfile() {
  const v = dd.version;
  const iconUrl = summoner?.profileIconId != null
    ? `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/${summoner.profileIconId}.png` : '';

  const rankCard = (label, entry) => {
    if (!entry) return `<div class="rank-card unranked">
      <div class="rank-crest">—</div>
      <div><div class="rank-queue">${label}</div><div class="rank-tier muted">Unranked</div></div></div>`;
    const games = entry.wins + entry.losses;
    const wr = games ? entry.wins / games : 0;
    const t = entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase();
    return `<div class="rank-card">
      <img class="rank-crest" src="${crestUrl(entry.tier)}" alt="${t}"/>
      <div>
        <div class="rank-queue">${label}</div>
        <div class="rank-tier">${t} ${entry.rank} · <b>${entry.leaguePoints} LP</b></div>
        <div class="rank-wl"><span class="wr ${wr >= 0.52 ? 'good' : wr <= 0.48 ? 'bad' : 'mid'}">${Math.round(wr * 100)}%</span>
          <span class="muted">${entry.wins}W ${entry.losses}L</span></div>
      </div></div>`;
  };

  const solo = leagueEntries.find(e => e.queueType === 'RANKED_SOLO_5x5');
  const flex = leagueEntries.find(e => e.queueType === 'RANKED_FLEX_SR');

  const recent = [...records].sort((a, b) => b.ts - a.ts);
  const last20 = recent.slice(0, 20);
  const wins20 = last20.filter(r => r.win).length;
  const k = last20.reduce((s, r) => s + r.k, 0), d = last20.reduce((s, r) => s + r.d, 0), a = last20.reduce((s, r) => s + r.a, 0);

  $('profileResults').innerHTML = `
    <div class="panel profile-header">
      ${iconUrl ? `<img class="profile-icon" src="${iconUrl}" alt=""/>` : ''}
      <div>
        <h2>${account.gameName} <span class="muted">#${account.tagLine}</span></h2>
        ${summoner ? `<div class="muted">Level ${summoner.summonerLevel}</div>` : ''}
      </div>
      <div class="rank-cards">
        ${rankCard('Ranked Solo/Duo', solo)}
        ${rankCard('Ranked Flex', flex)}
      </div>
    </div>
    <div class="panel">
      <h2>Recent games <span class="muted" style="font-weight:400;font-size:0.75em">
        last ${last20.length}: ${wins20}W ${last20.length - wins20}L (${last20.length ? Math.round(wins20 / last20.length * 100) : 0}%)
        · KDA ${(d === 0 ? k + a : (k + a) / d).toFixed(2)}</span></h2>
      <div class="match-list" id="matchList">${recent.slice(0, 25).map(matchRow).join('')}</div>
      ${recent.length > 25 ? `<button id="moreMatchesBtn" class="btn ghost" style="margin-top:10px">Show all ${recent.length} games</button>` : ''}
    </div>`;

  const moreBtn = $('moreMatchesBtn');
  if (moreBtn) moreBtn.onclick = () => {
    $('matchList').innerHTML = recent.map(matchRow).join('');
    moreBtn.remove();
  };
}

function matchRow(r) {
  const c = champOf(r.champ);
  const mine = r.participants.find(p => p.team === r.myTeam && p.champ === r.champ);
  const items = (mine?.items || []).map(id => {
    const it = dd.items[id];
    return it ? `<img src="${it.icon}" title="${it.name}" alt="" loading="lazy"/>` : '';
  }).join('');
  const mm = Math.floor(r.dur / 60);
  const kdaVal = r.d === 0 ? r.k + r.a : (r.k + r.a) / r.d;
  return `<div class="match-row ${r.win ? 'won' : 'lost'}">
    <div class="m-result">${r.win ? 'WIN' : 'LOSS'}<span class="muted">${QUEUE_NAMES[r.queue] || 'Other'}</span></div>
    <img class="m-champ" src="${c.icon}" alt="" loading="lazy"/>
    <div class="m-info">
      <b>${c.name}</b>
      <span class="muted">${ROLE_LABEL[r.pos] || ''}</span>
    </div>
    <div class="m-kda"><b>${r.k} / ${r.d} / ${r.a}</b><span class="muted">${kdaVal.toFixed(2)} KDA</span></div>
    <div class="m-items">${items}</div>
    <div class="m-meta"><span>${mm}m</span><span class="muted">${timeAgo(r.ts)}</span></div>
  </div>`;
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
    renderCounterTab();
  }
}

function renderCounterTab() {
  if (!agg) return;
  const role = $('myRole').value;

  $('enemyChips').innerHTML = enemyPicks.map(id => {
    const c = champOf(id);
    return `<span class="chip"><img src="${c.icon}" alt=""/>${c.name}
      <button data-id="${id}" title="Remove">✕</button></span>`;
  }).join('');
  $('enemyChips').querySelectorAll('button').forEach(b => {
    b.onclick = () => { enemyPicks = enemyPicks.filter(x => x !== b.dataset.id); renderCounterTab(); };
  });

  // never suggest a champion that's already picked by the enemy
  const taken = new Set(enemyPicks.map(x => x.toLowerCase()));
  const suggestions = suggestCounters(agg, enemyPicks, role)
    .filter(s => !taken.has(s.champ.toLowerCase()))
    .slice(0, 8);

  $('counterResults').innerHTML = !suggestions.length
    ? '<p class="muted">Not enough data yet — analyze more games.</p>'
    : suggestions.map((s, i) => {
        const c = champOf(s.champ);
        const evidence = s.notes.length
          ? s.notes.join(' · ')
          : enemyPicks.length
            ? 'No history vs these enemies — score is your comfort on this champ'
            : 'Ranked by your overall performance';
        const roleNote = s.roleFit ? ` · ${s.roleFit.wins}-${s.roleFit.games - s.roleFit.wins} as ${ROLE_LABEL[role]}` : '';
        return `<div class="suggestion${i === 0 ? ' top-pick' : ''}">
          <img class="portrait" src="${c.icon}" alt=""/>
          <div class="sugg-body">
            <div class="sugg-name">${i === 0 ? '⭐ ' : ''}${c.name}
              <span class="badge grey">${s.games} games</span>
              ${s.evidenceGames ? `<span class="badge blue">${s.evidenceGames}g vs picks</span>` : ''}
            </div>
            <div class="sugg-detail">${evidence}${roleNote}</div>
          </div>
          <div class="sugg-score">
            <div class="pct wr ${s.score >= 0.55 ? 'good' : s.score <= 0.45 ? 'bad' : 'mid'}">${Math.round(s.score * 100)}</div>
            <div class="muted">pick score</div>
          </div>
        </div>`;
      }).join('');

  // Meta gaps (also excluding enemy picks)
  const gaps = metaGaps(meta, agg, role).filter(g => !taken.has(g.id.toLowerCase())).slice(0, 10);
  $('metaResults').innerHTML = !gaps.length
    ? '<p class="muted">Nothing to suggest — you already play the meta picks for this role. 💪</p>'
    : `<table><thead><tr><th>Champion</th><th>Role</th><th>Why it's strong</th><th>Your games</th></tr></thead><tbody>` +
      gaps.map(g => `<tr>
        <td>${champCell(g.id)}</td>
        <td>${ROLE_LABEL[g.role] || g.role}</td>
        <td class="muted">${g.why}</td>
        <td>${g.playedGames === 0 ? '<span class="badge gold">NEW</span>' : `${g.playedGames}g`}</td>
      </tr>`).join('') + '</tbody></table>';
}

// ---------- Champion Pool & nemesis ----------
function renderPool() {
  const rows = Object.entries(agg.champStats)
    .sort((a, b) => b[1].games - a[1].games)
    .map(([champ, s]) => {
      const roles = Object.entries(s.roles).sort((a, b) => b[1].games - a[1].games)
        .map(([r, rs]) => `${ROLE_LABEL[r] || r} ${rs.games}g`).join(', ');
      let lpCell = '<span class="muted">—</span>';
      if (s.solo.games > 0) {
        const lp = (s.solo.wins * 2 - s.solo.games) * LP_PER_GAME;
        lpCell = `<span class="wr ${lp > 0 ? 'good' : lp < 0 ? 'bad' : 'mid'}">${lp > 0 ? '+' : ''}${lp} LP</span>
          <span class="muted">(${s.solo.games}g solo)</span>`;
      }
      return `<tr>
        <td>${champCell(champ)}</td>
        <td>${wrSpan(winrate(s), s.games)}</td>
        <td>${kda(s).toFixed(2)}</td>
        <td>${lpCell}</td>
        <td class="muted">${roles || '—'}</td>
      </tr>`;
    }).join('');
  $('poolResults').innerHTML =
    `<table><thead><tr><th>Champion</th><th>Winrate</th><th>KDA</th><th>Est. LP*</th><th>Roles</th></tr></thead><tbody>${rows}</tbody></table>
     <p class="muted" style="margin-top:10px">*Estimated from net Ranked Solo wins × ${LP_PER_GAME} LP — Riot's API doesn't expose actual LP changes per match.</p>`;

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
  const rows = Object.entries(agg.matchups)
    .sort((a, b) => b[1].games - a[1].games || winrate(b[1]) - winrate(a[1]))
    .map(([key, s]) => {
      const [mine, theirs] = key.split('|');
      return `<tr>
        <td>${champCell(mine, true)}</td>
        <td class="muted">vs</td>
        <td>${champCell(theirs, true)}</td>
        <td class="muted">${ROLE_LABEL[s.pos] || s.pos}</td>
        <td>${wrSpan(winrate(s), s.games)}</td>
      </tr>`;
    }).join('');
  $('matchupResults').innerHTML = rows
    ? `<table><thead><tr><th>You</th><th></th><th>Lane opponent</th><th>Lane</th><th>Winrate</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No lane matchup data — positions are only recorded in Summoner\'s Rift games.</p>';
}

// ---------- Builds & Runes ----------
function renderBuild(champId) {
  const b = buildStats(records, champId);
  const c = champOf(champId);
  if (!b.samples) {
    $('buildResults').innerHTML = `<p class="muted" style="margin-top:12px">
      No one played <b>${c.name}</b> in the ${records.length} analyzed matches. Analyze more games or pick another champion.</p>`;
    return;
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

  $('buildResults').innerHTML = `<div class="build-card">
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
async function checkLiveGame() {
  if (!api || !account) return showError('Analyze your account first.');
  hideError();
  $('liveBtn').disabled = true;
  $('liveResults').innerHTML = '<p class="muted" style="margin-top:12px">Checking…</p>';
  try {
    const game = await api.getActiveGame(account.puuid);
    if (!game) {
      $('liveResults').innerHTML = `<div class="insight warn" style="margin-top:14px">
        Not in a live game right now. The spectator API only works once the game has <b>started</b> —
        during champ select, use the 🎯 Counter Finder tab instead.</div>`;
      return;
    }
    const me = game.participants.find(p => p.puuid === account.puuid);
    const myTeam = me ? me.teamId : 100;
    const allies = game.participants.filter(p => p.teamId === myTeam);
    const enemies = game.participants.filter(p => p.teamId !== myTeam);
    const allyChampObjs = allies.map(p => dd.byKey[p.championId]).filter(Boolean);

    const teamRow = p => {
      const c = dd.byKey[p.championId];
      const name = p.riotId || c?.name || '?';
      let note = '';
      if (c && p.teamId !== myTeam) {
        const v = agg.vsEnemy[c.id];
        if (v && v.games >= 2) {
          const wr = Math.round(winrate(v) * 100);
          note = `<span class="vs-note">you win <b class="wr ${wr >= 55 ? 'good' : wr <= 45 ? 'bad' : 'mid'}">${wr}%</b> vs (${v.games}g)</span>`;
        }
      }
      return `<div class="team-row">${c ? `<img src="${c.icon}" alt=""/>` : ''}<b>${c?.name || '?'}</b>
        <span class="muted">${name !== c?.name ? name : ''}</span>${note}</div>`;
    };

    const insights = teamNeeds(allyChampObjs);
    const queueNote = QUEUE_NAMES[game.gameQueueConfigId] || `Queue ${game.gameQueueConfigId}`;
    const mins = Math.floor((game.gameLength > 0 ? game.gameLength : 0) / 60);

    $('liveResults').innerHTML = `
      <div class="insight" style="margin-top:14px">🟢 <b>Live game found</b> — ${queueNote}, ~${mins} min in.</div>
      <div class="live-teams">
        <div class="team-box ally"><h3>Your team</h3>${allies.map(teamRow).join('')}</div>
        <div class="team-box enemy"><h3>Enemy team</h3>${enemies.map(teamRow).join('')}</div>
      </div>
      <div class="panel" style="margin-top:16px"><h2>Team composition insights</h2>
        ${insights.map(i => `<div class="insight ${i.type === 'warn' ? 'warn' : ''}">${i.text}</div>`).join('')}
      </div>`;
  } catch (e) {
    $('liveResults').innerHTML = '';
    showError(e instanceof RiotAPIError ? e.message : (e.message || String(e)));
  } finally {
    $('liveBtn').disabled = false;
  }
}
