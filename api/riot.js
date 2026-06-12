// Vercel serverless proxy for the Riot API.
// The frontend calls /api/riot?host=<cluster|platform>&path=<riot-path> and this
// function adds the secret key (RIOT_API_KEY env var) and forwards to Riot.
// The key never reaches the browser.

const ALLOWED_HOSTS = new Set([
  // regional routing clusters
  'americas', 'asia', 'europe', 'sea',
  // platform routing hosts
  'na1', 'br1', 'la1', 'la2', 'euw1', 'eun1', 'tr1', 'ru', 'me1',
  'kr', 'jp1', 'oc1', 'sg2', 'tw2', 'vn2', 'ph2', 'th2',
]);

export default async function handler(req, res) {
  const key = process.env.RIOT_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'RIOT_API_KEY is not configured on the server.' });
  }

  const host = req.query.host;
  const path = req.query.path;
  if (!host || !path || !ALLOWED_HOSTS.has(host) || !/^\/(lol|riot)\//.test(path)) {
    return res.status(400).json({ error: 'Bad proxy request (host/path not allowed).' });
  }

  try {
    const upstream = await fetch(`https://${host}.api.riotgames.com${path}`, {
      headers: { 'X-Riot-Token': key },
    });
    const body = await upstream.text();
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(body || '{}');
  } catch {
    return res.status(502).json({ error: 'Upstream Riot request failed.' });
  }
}
