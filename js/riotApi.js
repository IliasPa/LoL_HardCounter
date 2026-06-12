// Riot API client — talks to our own /api/riot serverless proxy (which holds the
// secret key), never to Riot directly. Still throttles client-side to avoid 429s.

const PLATFORM_TO_REGIONAL = {
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea', ph2: 'sea', th2: 'sea',
};

export class RiotAPIError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class RiotAPI {
  constructor() {
    this.platform = null;             // detected after account lookup
    this.regional = 'europe';         // default cluster for the account lookup
    this.timestamps = [];             // request times for rate limiting
  }

  setPlatform(platform) {
    this.platform = platform;
    this.regional = PLATFORM_TO_REGIONAL[platform] || 'europe';
  }

  async throttle() {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(t => now - t < 120000);
      const lastSecond = this.timestamps.filter(t => now - t < 1100).length;
      const lastTwoMin = this.timestamps.length;
      if (lastSecond < 18 && lastTwoMin < 95) {
        this.timestamps.push(now);
        return;
      }
      const wait = lastTwoMin >= 95
        ? this.timestamps[0] + 121000 - now
        : 250;
      await sleep(Math.max(wait, 100));
    }
  }

  async request(host, path, attempt = 0) {
    await this.throttle();
    const url = `/api/riot?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new RiotAPIError(0, 'Network error — could not reach the server.');
    }
    if (res.status === 429 && attempt < 3) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '10', 10);
      await sleep((retryAfter + 1) * 1000);
      return this.request(host, path, attempt + 1);
    }
    if (!res.ok) {
      const messages = {
        400: 'Bad request.',
        401: 'Server Riot key missing or invalid.',
        403: 'Server Riot key invalid or expired (dev keys expire every 24h — set a fresh RIOT_API_KEY).',
        404: 'NOT_FOUND',
        429: 'Rate limited by Riot. Wait a minute and try again.',
        500: 'Server is missing the RIOT_API_KEY environment variable.',
        503: 'Riot API is temporarily unavailable. Try again shortly.',
      };
      throw new RiotAPIError(res.status, messages[res.status] || `Riot API error (HTTP ${res.status}).`);
    }
    return res.json();
  }

  regionalReq(path) { return this.request(this.regional, path); }
  platformReq(path) { return this.request(this.platform, path); }

  // --- Account / identity (regional routing; clusters are globally synced) ---
  async getAccountByRiotId(gameName, tagLine) {
    const path = `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    for (const cluster of ['europe', 'americas', 'asia']) {
      try {
        return await this.request(cluster, path);
      } catch (e) {
        if (e.status !== 404) throw e; // real error — surface it, don't keep trying
      }
    }
    throw new RiotAPIError(404, `Account "${gameName}#${tagLine}" not found. Check the spelling (Name#TAG).`);
  }

  // Detect which platform (euw1, na1, kr…) an account plays on, from the puuid alone.
  async detectPlatform(puuid) {
    // 1) Riot's region endpoint (not always enabled for dev keys)
    try {
      const r = await this.request(this.regional, `/riot/account/v1/region/by-game/lol/by-puuid/${puuid}`);
      const plat = String(r?.region || '').toLowerCase();
      if (PLATFORM_TO_REGIONAL[plat]) return plat;
    } catch { /* fall through to probing */ }
    // 2) Probe match clusters — the newest match id is prefixed with the platform
    //    ("EUW1_123…"), which is ground truth for where the account plays.
    for (const cluster of ['europe', 'americas', 'asia', 'sea']) {
      try {
        const ids = await this.request(cluster, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1`);
        if (ids?.length) {
          const plat = ids[0].split('_')[0].toLowerCase();
          if (PLATFORM_TO_REGIONAL[plat]) return plat;
        }
      } catch { /* wrong cluster or hiccup — try the next */ }
    }
    return null;
  }

  // --- Match history ---
  getMatchIds(puuid, { start = 0, count = 100, queue = null, type = null } = {}) {
    let q = `start=${start}&count=${count}`;
    if (queue) q += `&queue=${queue}`;
    if (type) q += `&type=${type}`;
    return this.regionalReq(`/lol/match/v5/matches/by-puuid/${puuid}/ids?${q}`);
  }

  getMatch(matchId) {
    return this.regionalReq(`/lol/match/v5/matches/${matchId}`);
  }

  // --- Summoner profile (icon, level) ---
  getSummoner(puuid) {
    return this.platformReq(`/lol/summoner/v4/summoners/by-puuid/${puuid}`);
  }

  // --- Ranked info ---
  getLeagueEntries(puuid) {
    return this.platformReq(`/lol/league/v4/entries/by-puuid/${puuid}`);
  }

  // --- Champion mastery ---
  getTopMasteries(puuid, count = 5) {
    return this.platformReq(`/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${count}`);
  }

  // --- Live game ---
  async getActiveGame(puuid) {
    try {
      return await this.platformReq(`/lol/spectator/v5/active-games/by-summoner/${puuid}`);
    } catch (e) {
      if (e.status === 404) return null; // not in game
      throw e;
    }
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
