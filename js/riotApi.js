// Riot API client — browser-side, key passed as ?api_key= (Riot sends CORS headers).
// Respects dev-key rate limits: 20 req / 1s and 100 req / 2min, with 429 retry.

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
  constructor(apiKey, platform) {
    this.apiKey = apiKey.trim();
    this.platform = platform;
    this.regional = PLATFORM_TO_REGIONAL[platform] || 'europe';
    this.timestamps = []; // request times for rate limiting
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
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://${host}.api.riotgames.com${path}${sep}api_key=${encodeURIComponent(this.apiKey)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new RiotAPIError(0, 'Network error — check your connection (or an ad-blocker is blocking api.riotgames.com).');
    }
    if (res.status === 429 && attempt < 3) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '10', 10);
      await sleep((retryAfter + 1) * 1000);
      return this.request(host, path, attempt + 1);
    }
    if (!res.ok) {
      const messages = {
        400: 'Bad request.',
        401: 'API key missing or invalid. Open 🔑 settings and paste a valid key.',
        403: 'API key invalid or expired. Dev keys expire every 24h — grab a fresh one at developer.riotgames.com.',
        404: 'NOT_FOUND',
        429: 'Rate limited by Riot. Wait a minute and try again.',
        503: 'Riot API is temporarily unavailable. Try again shortly.',
      };
      throw new RiotAPIError(res.status, messages[res.status] || `Riot API error (HTTP ${res.status}).`);
    }
    return res.json();
  }

  regionalReq(path) { return this.request(this.regional, path); }
  platformReq(path) { return this.request(this.platform, path); }

  // --- Account / identity ---
  async getAccountByRiotId(gameName, tagLine) {
    try {
      return await this.regionalReq(
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
      );
    } catch (e) {
      if (e.status === 404) throw new RiotAPIError(404, `Account "${gameName}#${tagLine}" not found in this region group. Check the spelling and the region.`);
      throw e;
    }
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
