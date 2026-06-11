# ⚔️ LoL HardCounter

A **100% static** web app (perfect for GitHub Pages) that analyzes your League of Legends match
history and tells you **what to pick against whom** — based on *your own* winrates, not just
global stats.

## Features

- 🎯 **Counter Finder** — during champ select, type the enemy picks as they lock in. Get ranked
  suggestions from your champion pool (enemy-picked champs excluded), scored by your personal
  lane-matchup and map-presence winrates (Bayesian-smoothed so 1-game samples don't dominate).
- 👤 **Profile** — Ranked Solo/Flex tier, LP, wins/losses with rank crests, plus a u.gg-style
  recent match list (result, champ, KDA, items, duration). Champion Pool also shows estimated
  LP gained per champ (net solo-queue wins × 25 — Riot's API doesn't expose real LP per match).
- 📡 **Live Game scouting** — once the game starts, see both teams, your historical winrate vs
  each enemy champion, and team-composition insights (damage mix AD/AP, frontline, peel, etc.).
- 🏆 **Champion Pool** — winrate, KDA and role distribution for every champ you play, plus a
  "nemesis" list of enemy champions you consistently lose against.
- ⚔️ **Matchups** — your full lane-matchup history (same position, opposite team).
- 🛠️ **Builds & Runes** — mined from your analyzed matches: every player of a champion across
  your games, weighted toward winning games. Keystones, rune trees, most successful items.
- 📈 **Meta picks you don't play** — curated high-winrate champs per role
  (edit [data/meta.json](data/meta.json) each patch — there is no free global-winrate API).

## How it works (and why it can be static)

- **Riot API** (free) for account lookup, match history (match-v5) and live games (spectator-v5).
  Riot's API sends CORS headers, so the browser calls it directly — no backend needed.
- **Data Dragon** (Riot's free CDN, no key) for champion/rune/item data and images.
- Matches are cached compactly in `localStorage`, so re-analyzing is fast and doesn't burn your
  rate limit.
- ☁️ **Optional GitHub sync**: paste a GitHub token with the `gist` scope and your analyzed data
  is saved to a **private gist** right after every analysis, and restored on any device before
  fetching — making "All games" analyses a one-time cost. You can also **export/import a plain
  JSON file** from the 🔑 settings panel.
- Your Riot key and data never leave your browser except to Riot — and, only if you opt in,
  to your own private GitHub gist.

## Setup

1. Get a free API key at [developer.riotgames.com](https://developer.riotgames.com)
   (log in with your Riot account → copy the *Development API Key*).
   - ⚠️ Dev keys expire **every 24 hours**. For a permanent key, register a free
     **Personal App** on the same page (approval usually takes a day or two).
2. Open the app, click 🔑, paste the key, save.
3. Enter your Riot ID (`Name#TAG`), select region and number of games, hit **Analyze**.

## Run locally

Any static server works (ES modules don't run from `file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

```bash
git init && git add -A && git commit -m "LoL HardCounter"
gh repo create lol-hardcounter --public --source=. --push
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
The app will be live at `https://<you>.github.io/lol-hardcounter/`.

## Rate limits

A dev key allows 20 requests/s and 100 requests/2 min. The app throttles itself and retries on
429. Analyzing 200 games the first time takes ~2.5 minutes; cached re-runs are instant.

## Notes & limitations

- Lane matchups need `teamPosition`, which Riot only records on Summoner's Rift — ARAM/Arena
  games are skipped.
- Spectator (live game) only works once the game has **started**; for champ select use the
  Counter Finder tab.
- "Meta picks" are a hand-curated list in `data/meta.json` — keep it fresh each patch using
  op.gg / u.gg / lolalytics, since no free public API exposes global winrates.

---

*LoL HardCounter isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot
Games or anyone officially involved in producing or managing League of Legends. League of
Legends © Riot Games, Inc.*
