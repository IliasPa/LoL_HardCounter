// Turns raw match-v5 JSON into compact records, then aggregates:
// champion pool stats, lane matchups, vs-enemy presence winrates, builds & runes.

// Summoner's Rift queues we analyze (positions are only meaningful here)
export const SR_QUEUES = new Set([400, 420, 430, 440, 490, 700]);

// Bump this whenever extractRecord gains fields: cached records with an older
// (or missing) version are ignored and refetched, wherever they were cached.
export const REC_VERSION = 2;

// ---------- Compact record extraction (this is what we cache) ----------

export function extractRecord(match, puuid) {
  const info = match.info;
  const me = info.participants.find(p => p.puuid === puuid);
  if (!me) return null;

  const participants = info.participants.map(p => ({
    champ: p.championName,
    pos: p.teamPosition || '',
    team: p.teamId,
    win: p.win,
    me: p.puuid === puuid || undefined,
    puuid: p.puuid,
    name: p.riotIdGameName || p.summonerName || '',
    k: p.kills, d: p.deaths, a: p.assists,
    lvl: p.champLevel,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    gold: p.goldEarned,
    dmg: p.totalDamageDealtToChampions,
    vision: p.visionScore,
    spells: [p.summoner1Id, p.summoner2Id],
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].filter(i => i > 0),
    keystone: p.perks?.styles?.[0]?.selections?.[0]?.perk ?? 0,
    primaryStyle: p.perks?.styles?.[0]?.style ?? 0,
    subStyle: p.perks?.styles?.[1]?.style ?? 0,
    runes: (p.perks?.styles ?? []).flatMap(s => s.selections.map(sel => sel.perk)),
  }));

  return {
    id: match.metadata.matchId,
    rv: REC_VERSION,
    queue: info.queueId,
    ts: info.gameCreation,
    dur: info.gameDuration,
    ver: (info.gameVersion || '').split('.').slice(0, 2).join('.'), // patch, e.g. "15.11"
    win: me.win,
    champ: me.championName,
    pos: me.teamPosition || '',
    k: me.kills, d: me.deaths, a: me.assists,
    dk: me.doubleKills, tk: me.tripleKills, qk: me.quadraKills, pk: me.pentaKills,
    myTeam: me.teamId,
    participants,
  };
}

// ---------- Aggregation ----------

export function aggregate(records) {
  const champStats = {};   // myChamp -> {games, wins, k, d, a, roles:{}}
  const matchups = {};     // "myChamp|enemyChamp" -> {games, wins, pos} (lane opponents)
  const vsEnemy = {};      // enemyChamp -> {games, wins} (enemy anywhere on map)
  const myVsEnemy = {};    // "myChamp|enemyChamp" -> {games, wins} (enemy anywhere)
  const withAlly = {};     // allyChamp (teammate, not me) -> {games, wins}
  let wins = 0;
  const srRecords = records.filter(r => SR_QUEUES.has(r.queue));

  for (const r of srRecords) {
    if (r.win) wins++;

    const cs = champStats[r.champ] ??= { games: 0, wins: 0, k: 0, d: 0, a: 0, roles: {}, solo: { games: 0, wins: 0 }, mk: { d: 0, t: 0, q: 0, p: 0 } };
    cs.games++; if (r.win) cs.wins++;
    cs.k += r.k; cs.d += r.d; cs.a += r.a;
    cs.mk.d += r.dk || 0; cs.mk.t += r.tk || 0; cs.mk.q += r.qk || 0; cs.mk.p += r.pk || 0;
    if (r.queue === 420) { cs.solo.games++; if (r.win) cs.solo.wins++; }
    if (r.pos) {
      const role = cs.roles[r.pos] ??= { games: 0, wins: 0 };
      role.games++; if (r.win) role.wins++;
    }

    const enemies = r.participants.filter(p => p.team !== r.myTeam);

    // direct lane opponent
    if (r.pos) {
      const opp = enemies.find(p => p.pos === r.pos);
      if (opp) {
        const m = matchups[`${r.champ}|${opp.champ}`] ??= { games: 0, wins: 0, pos: r.pos };
        m.games++; if (r.win) m.wins++;
      }
    }

    // enemy anywhere on the map
    for (const e of enemies) {
      const v = vsEnemy[e.champ] ??= { games: 0, wins: 0 };
      v.games++; if (r.win) v.wins++;
      const mv = myVsEnemy[`${r.champ}|${e.champ}`] ??= { games: 0, wins: 0 };
      mv.games++; if (r.win) mv.wins++;
    }

    // teammates (skip myself once — same champ can't appear twice on a team)
    let selfSkipped = false;
    for (const al of r.participants.filter(p => p.team === r.myTeam)) {
      if (!selfSkipped && (al.me || al.champ === r.champ)) { selfSkipped = true; continue; }
      const w = withAlly[al.champ] ??= { games: 0, wins: 0 };
      w.games++; if (r.win) w.wins++;
    }
  }

  return {
    totalGames: srRecords.length,
    totalWins: wins,
    champStats,
    matchups,
    vsEnemy,
    myVsEnemy,
    withAlly,
  };
}

// ---------- Builds & runes (mined from every player of a champ in your games) ----------

export function buildStats(records, champId) {
  const itemCount = {};        // itemId -> {games, wins}
  const keystoneCount = {};    // perkId -> {games, wins}
  const treeCount = {};        // "primary|sub" -> {games, wins}
  let samples = 0, sampleWins = 0;

  for (const r of records) {
    if (!SR_QUEUES.has(r.queue)) continue;
    for (const p of r.participants) {
      if (p.champ !== champId) continue;
      samples++; if (p.win) sampleWins++;
      // wins weigh double so the "winning build" dominates
      const w = p.win ? 2 : 1;
      for (const it of p.items) {
        const c = itemCount[it] ??= { score: 0, games: 0, wins: 0 };
        c.score += w; c.games++; if (p.win) c.wins++;
      }
      if (p.keystone) {
        const c = keystoneCount[p.keystone] ??= { score: 0, games: 0, wins: 0 };
        c.score += w; c.games++; if (p.win) c.wins++;
      }
      if (p.primaryStyle && p.subStyle) {
        const c = treeCount[`${p.primaryStyle}|${p.subStyle}`] ??= { score: 0, games: 0, wins: 0 };
        c.score += w; c.games++; if (p.win) c.wins++;
      }
    }
  }

  const top = (obj, n) => Object.entries(obj)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, n)
    .map(([key, v]) => ({ key, ...v }));

  return {
    samples,
    sampleWins,
    items: top(itemCount, 8),
    keystones: top(keystoneCount, 3),
    trees: top(treeCount, 2),
  };
}

// ---------- Helpers ----------

export function winrate(s) { return s.games ? s.wins / s.games : 0; }

export function kda(s) {
  return s.d === 0 ? (s.k + s.a) : (s.k + s.a) / s.d;
}
