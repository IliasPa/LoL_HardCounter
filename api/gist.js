// Vercel serverless proxy for the GitHub Gist API.
// The frontend calls /api/gist?path=<github-path> and this function adds the
// secret token (GITHUB_GIST_KEY env var) and forwards to GitHub. Used to sync
// analyzed match data to one private gist. If the env var is unset, sync is off.

export default async function handler(req, res) {
  const token = process.env.GITHUB_GIST_KEY;
  if (!token) {
    return res.status(501).json({ error: 'GitHub sync is not configured on the server.' });
  }

  const path = req.query.path;
  if (!path || !/^\/(gists|user)\b/.test(path)) {
    return res.status(400).json({ error: 'Bad gist request (path not allowed).' });
  }

  const method = req.method || 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  try {
    const upstream = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'LoL-HardCounter',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
    });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(body || '{}');
  } catch {
    return res.status(502).json({ error: 'Upstream GitHub request failed.' });
  }
}
