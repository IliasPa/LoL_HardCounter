# ⚔️ LoL HardCounter

A web app that analyzes your League of Legends match history and tells you **what to pick
against whom** — based on *your own* winrates, not just global stats. The frontend is plain
ES-module JavaScript; all Riot calls go through **Vercel serverless functions** so your API
key stays on the server.

## Features

- 🏆 **Counter Finder / Champion Pool** — during champ select, type the enemy picks as they lock
  in. A unified table ranks your champions by a **Pick score** (your personal lane-matchup and
  map-presence winrates, Bayesian-smoothed, blended with your comfort on each champ). Sort by any
  column; click a champ to expand its **builds & runes**, mined from your own games.
- 👤 **Profile** — account header with level, rank crests (Solo/Flex), winrate, top champs and
  main role. A u.gg-style match list (summoner spells, keystone + secondary rune, KDA, items);
  click any game to expand the full scoreboard with per-player ranks, damage bars and CS/min.
- 📈 **Climb** — rolling winrate trend, winrate by weekday / time of day, a **tilt check**
  (your winrate after a loss vs after a win, after 2+ losses, long-session drop-off) and
  winrate by patch.
- ⚔️ **Matchups** — your full lane-matchup history (same position, opposite team), filterable.
- 📡 **Live Game scouting** — once the game starts, see both teams with your historical winrate
  vs each champion, each player's **rank and champion-mastery mains**, and an optional **deep
  scout** of every player's last 8 games (recent form, streaks, whether they're off-role). Plus
  plain-language team-composition insights (damage mix, frontline, peel, scaling, game plan).

## How it works

- **Riot API** (free) for account lookup, match history (match-v5), ranks, mastery and live games
  (spectator-v5) — proxied through `/api/riot` so the key never reaches the browser. Region is
  **auto-detected** from your Riot ID (no region picker).
- **Data Dragon** (Riot's free CDN, no key) for champion / rune / item / spell data and images.
- Matches are cached compactly in `localStorage`, so re-analyzing is fast and doesn't burn your
  rate limit. Optional **GitHub Gist sync** (via `/api/gist`) saves analyzed data to one private
  gist so it survives browsers and devices. You can also export/import a plain JSON file.

## Setup & deploy (Vercel)

1. Get a free Riot API key at [developer.riotgames.com](https://developer.riotgames.com)
   (log in → copy the *Development API Key*).
   - ⚠️ Dev keys expire **every 24 hours**. For a permanent key, register a free **Personal App**
     on the same page (approval usually takes a day or two).
2. Import the repo into [Vercel](https://vercel.com) (New Project → import from GitHub).
3. In **Project → Settings → Environment Variables**, add:
   - `RIOT_API_KEY` — your Riot key (**required**).
   - `GITHUB_GIST_KEY` — a GitHub token with the `gist` scope (**optional**, enables cloud sync).
4. Deploy. Open the app, enter your Riot ID (`Name#TAG`), pick the queue and number of games, hit
   **Analyze**.

## Run locally

The `/api` functions need the Vercel runtime, so use the Vercel CLI:

```bash
npm i -g vercel
cp .env.example .env.local   # then fill in RIOT_API_KEY (and optionally GITHUB_GIST_KEY)
vercel dev                   # serves the static app + /api on http://localhost:3000
```

(`.env.local` is gitignored — your key is never committed.)

## Rate limits

A dev key allows 20 requests/s and 100 requests/2 min. The client throttles itself and retries on
429. Analyzing 200 games the first time takes ~2.5 minutes; cached re-runs are instant. Live-game
**deep scout** makes ~45 calls (the button warns you) — a Personal key makes it smoother.

## Notes & limitations

- Lane matchups need `teamPosition`, which Riot only records on Summoner's Rift — ARAM/Arena
  games are skipped.
- Spectator (live game) only works once the game has **started**; for champ select use the
  Counter Finder tab.
- This app uses serverless functions, so the **GitHub Pages** build of this repo will not work —
  deploy on Vercel (or any host that runs the `/api` functions).

---

*LoL HardCounter isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot
Games or anyone officially involved in producing or managing League of Legends. League of
Legends © Riot Games, Inc.*
