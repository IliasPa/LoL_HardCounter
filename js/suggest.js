// Pick-suggestion logic: combines YOUR matchup history (lane + map presence)
// with Bayesian smoothing, plus team-composition insights from champion attributes.

import { winrate } from './analysis.js';

// How many "virtual games" pull a small sample toward the prior. Higher = more skeptical of 1-2 game samples.
const SMOOTH_K = 4;

function smoothed(wins, games, prior) {
  return (wins + SMOOTH_K * prior) / (games + SMOOTH_K);
}

/**
 * Rank the user's champions against a set of enemy champions.
 * enemyChamps: array of ddragon ids (e.g. ["Darius","Ahri"]).
 * role: optional teamPosition filter ("TOP"...) — boosts champs you actually play there.
 */
export function suggestCounters(agg, enemyChamps, role = '') {
  const results = [];

  for (const [champ, cs] of Object.entries(agg.champStats)) {
    if (cs.games < 1) continue;
    const overallWr = winrate(cs);
    const prior = smoothed(cs.wins, cs.games, 0.5); // champ comfort, itself smoothed

    let evidenceGames = 0;
    let scoreSum = 0;
    let weightSum = 0;
    const notes = [];

    for (const enemy of enemyChamps) {
      // Lane matchup (strong signal)
      const lane = agg.matchups[`${champ}|${enemy}`];
      // Anywhere on the map (weaker signal)
      const map = agg.myVsEnemy[`${champ}|${enemy}`];

      if (lane && lane.games > 0) {
        const wr = smoothed(lane.wins, lane.games, prior);
        const w = 2 + Math.min(lane.games, 6); // lane evidence weighs heavy
        scoreSum += wr * w; weightSum += w;
        evidenceGames += lane.games;
        notes.push(`${lane.wins}-${lane.games - lane.wins} in lane vs ${enemy}`);
      } else if (map && map.games > 0) {
        const wr = smoothed(map.wins, map.games, prior);
        const w = 1 + Math.min(map.games, 4) * 0.5;
        scoreSum += wr * w; weightSum += w;
        evidenceGames += map.games;
        notes.push(`${map.wins}-${map.games - map.wins} vs ${enemy} (any lane)`);
      }
    }

    // No matchup data at all → fall back to champ comfort only
    let score = weightSum > 0
      ? (scoreSum + prior * 1) / (weightSum + 1)   // blend in comfort as one extra vote
      : prior;

    // Role fit: boost champs you actually play in the selected role
    let roleFit = null;
    if (role) {
      const rs = cs.roles[role];
      if (rs && rs.games > 0) {
        roleFit = rs;
        score += 0.03 * Math.min(rs.games / 5, 1);
      } else {
        score -= 0.06; // you don't play this champ in that role
      }
    }

    results.push({
      champ,
      score,
      overallWr,
      games: cs.games,
      evidenceGames,
      roleFit,
      notes: notes.slice(0, 4),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Meta picks the user hasn't played (or barely played) — from data/meta.json.
 * Returns entries enriched with how much the user has played them.
 */
export function metaGaps(meta, agg, role = '') {
  const out = [];
  for (const [r, picks] of Object.entries(meta.roles)) {
    if (role && r !== role) continue;
    for (const p of picks) {
      const played = agg.champStats[p.id];
      if (played && played.games >= 5) continue; // they already play it
      out.push({ ...p, role: r, playedGames: played?.games || 0 });
    }
  }
  return out;
}

// ---------- Team composition insight ----------

/**
 * allyChamps: array of champ objects from ddragon (with tags + info).
 * Returns human-readable insights about what the team has / lacks.
 */
export function teamNeeds(allyChamps) {
  if (!allyChamps.length) return [];
  const insights = [];

  let physical = 0, magic = 0, frontline = 0, ranged = 0;
  const tagCount = {};
  for (const c of allyChamps) {
    physical += c.info.attack;
    magic += c.info.magic;
    if (c.info.defense >= 6 || c.tags.includes('Tank')) frontline++;
    if (c.tags.includes('Marksman') || c.tags.includes('Mage')) ranged++;
    for (const t of c.tags) tagCount[t] = (tagCount[t] || 0) + 1;
  }

  const total = physical + magic || 1;
  const adShare = physical / total;

  if (adShare > 0.72) {
    insights.push({ type: 'warn', text: `Damage is heavily physical (${Math.round(adShare * 100)}% AD-leaning) — the enemy can stack armor. An AP threat (mage, AP bruiser) would help.` });
  } else if (adShare < 0.28) {
    insights.push({ type: 'warn', text: `Damage is heavily magic (${Math.round((1 - adShare) * 100)}% AP-leaning) — the enemy can stack magic resist. An AD threat would help.` });
  } else {
    insights.push({ type: 'ok', text: `Damage profile is mixed (≈${Math.round(adShare * 100)}% physical / ${Math.round((1 - adShare) * 100)}% magic) — hard to itemize against. 👍` });
  }

  if (frontline === 0) {
    insights.push({ type: 'warn', text: 'No real frontline — consider a tank or beefy fighter to start fights and absorb damage.' });
  } else if (frontline >= 3) {
    insights.push({ type: 'warn', text: 'Lots of frontline but possibly low damage — make sure someone can actually kill things.' });
  } else {
    insights.push({ type: 'ok', text: `Frontline looks adequate (${frontline} durable pick${frontline > 1 ? 's' : ''}).` });
  }

  if (!tagCount['Marksman']) {
    insights.push({ type: 'warn', text: 'No marksman — taking towers, Baron and Dragon will be slower. Sustained DPS would help.' });
  }
  if ((tagCount['Assassin'] || 0) >= 2) {
    insights.push({ type: 'warn', text: 'Multiple assassins — strong vs squishies but the comp may fall over if behind. A reliable engage/peel pick adds safety.' });
  }
  if (!tagCount['Support'] && !tagCount['Tank'] && (tagCount['Mage'] || 0) + (tagCount['Marksman'] || 0) >= 3) {
    insights.push({ type: 'warn', text: 'Very squishy comp — peel and disengage (enchanter / warden) would protect your carries.' });
  }

  return insights;
}
