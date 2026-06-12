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

// ---------- Team composition insights ----------

function compProfile(champs) {
  const p = { physical: 0, magic: 0, frontline: 0, tags: {} };
  for (const c of champs) {
    p.physical += c.info.attack;
    p.magic += c.info.magic;
    if (c.info.defense >= 6 || c.tags.includes('Tank')) p.frontline++;
    for (const t of c.tags) p.tags[t] = (p.tags[t] || 0) + 1;
  }
  p.adShare = p.physical / ((p.physical + p.magic) || 1);
  p.scalers = (p.tags.Marksman || 0) + (p.tags.Mage || 0);      // late-game DPS
  p.divers = (p.tags.Assassin || 0) + (p.tags.Fighter || 0);    // skirmish power
  p.squishy = !p.tags.Tank && p.frontline === 0;
  return p;
}

/**
 * Both teams' champ objects from ddragon (tags + info).
 * Returns [{section: 'Your team'|'Enemy team'|'Game plan', type: 'ok'|'warn'|'info', text}].
 * Each text leads with a <b>bold takeaway</b>, then one plain sentence of advice.
 */
export function teamInsights(allies, enemies) {
  const out = [];
  const add = (section, type, text) => out.push({ section, type, text });
  const a = compProfile(allies), e = compProfile(enemies);
  const pct = x => Math.round(x * 100);

  // --- Your team ---
  if (allies.length) {
    if (a.adShare > 0.72) {
      add('Your team', 'warn', `<b>Almost all your damage is physical (${pct(a.adShare)}%)</b> — the enemy can stack armor and shrug you off. Whoever can, build some armor penetration.`);
    } else if (a.adShare < 0.28) {
      add('Your team', 'warn', `<b>Almost all your damage is magic (${pct(1 - a.adShare)}%)</b> — the enemy can stack magic resist. Whoever can, build magic penetration.`);
    } else {
      add('Your team', 'ok', `<b>Mixed damage (≈${pct(a.adShare)}% physical / ${pct(1 - a.adShare)}% magic)</b> — the enemy can't itemize against everyone at once.`);
    }
    if (a.frontline === 0) {
      add('Your team', 'warn', `<b>No frontline</b> — nobody can start fights or soak damage. Avoid head-on 5v5s; win with poke and picks instead.`);
    } else if (a.frontline >= 3) {
      add('Your team', 'warn', `<b>Very tanky team (${a.frontline} durable picks)</b> — you may lack damage. Funnel gold to your main carry and end fights fast.`);
    } else {
      add('Your team', 'ok', `<b>Solid frontline (${a.frontline})</b> — you can take fights head-on.`);
    }
    if (!a.tags.Marksman) {
      add('Your team', 'warn', `<b>No marksman</b> — towers, Baron and Dragon die slowly for you. Only start objectives with a clear numbers advantage.`);
    }
    if (a.squishy && (a.tags.Mage || 0) + (a.tags.Marksman || 0) >= 3) {
      add('Your team', 'warn', `<b>Very squishy comp</b> — one good engage can wipe you. Stay spread until their engage is down, then collapse.`);
    }
  }

  // --- Enemy team ---
  if (enemies.length) {
    if (e.adShare > 0.72) {
      add('Enemy team', 'info', `<b>Enemy damage is mostly physical (${pct(e.adShare)}%)</b> — armor is gold-efficient against them; grab early armor components.`);
    } else if (e.adShare < 0.28) {
      add('Enemy team', 'info', `<b>Enemy damage is mostly magic (${pct(1 - e.adShare)}%)</b> — magic resist is gold-efficient against them; grab early MR components.`);
    }
    if (e.frontline >= 2) {
      add('Enemy team', 'info', `<b>Tanky enemy frontline (${e.frontline})</b> — don't dump everything into the tanks. % health damage helps; carries should hit whoever dives them, assassins should go around.`);
    } else if (e.frontline === 0) {
      add('Enemy team', 'ok', `<b>Enemy has no frontline</b> — they're all squishy. Hard engage on anyone wins the fight.`);
    }
    if ((e.tags.Assassin || 0) >= 1) {
      add('Enemy team', 'warn', `<b>Assassin threat (${e.tags.Assassin})</b> — your squishies must not walk alone. Save peel (exhaust, knock-ups, shields) for the moment they jump in.`);
    }
    if ((e.tags.Marksman || 0) >= 1 && e.squishy === false && e.frontline >= 2) {
      add('Enemy team', 'info', `<b>Protect-the-carry setup</b> — killing their marksman first usually decides the fight.`);
    }
  }

  // --- Game plan ---
  if (allies.length && enemies.length) {
    if (a.scalers > e.scalers) {
      add('Game plan', 'ok', `<b>You outscale them</b> — don't take coin-flip fights early. Farm safely, trade objectives evenly, and the game gets easier every minute.`);
    } else if (a.scalers < e.scalers) {
      add('Game plan', 'warn', `<b>They outscale you</b> — your window is the early/mid game. Play aggressively, snowball a lead, and try to end before ~30 minutes.`);
    } else {
      add('Game plan', 'info', `<b>Even scaling</b> — the game hinges on objective control. Track Dragon and Baron timers and set up 30s before they spawn.`);
    }
    if (a.divers >= 3) {
      add('Game plan', 'info', `<b>You have a skirmish comp</b> — look for 2v2/3v3 fights, river/jungle picks and side-lane pressure rather than full 5v5s.`);
    } else if (a.frontline >= 1 && (a.tags.Marksman || 0) >= 1 && a.scalers >= 2) {
      add('Game plan', 'info', `<b>You have a teamfight comp</b> — group as five around objectives and force front-to-back fights.`);
    }
  }

  return out;
}
