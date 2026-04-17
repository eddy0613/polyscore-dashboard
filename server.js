const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DD_API_KEY = process.env.DD_API_KEY;
const DD_APP_KEY = process.env.DD_APP_KEY;

app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint: /api/polyscores?from=ISO&to=ISO
app.get('/api/polyscores', async (req, res) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to query params required (ISO 8601)' });
    }

    const payload = {
      filter: {
        query: 'service:callamari @client_env:live',
        from,
        to,
      },
      compute: [
        { aggregation: 'avg', metric: '@poly_score' },
        { aggregation: 'count' },
      ],
      group_by: [
        { facet: '@account_id', limit: 50 },
        { facet: '@project_id', limit: 50 },
      ],
      page: { limit: 1000 },
    };

    const ddRes = await fetch(
      'https://api.datadoghq.com/api/v2/logs/analytics/aggregate',
      {
        method: 'POST',
        headers: {
          'DD-API-KEY': DD_API_KEY,
          'DD-APPLICATION-KEY': DD_APP_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!ddRes.ok) {
      const text = await ddRes.text();
      return res.status(ddRes.status).json({ error: text });
    }

    const data = await ddRes.json();
    const buckets = data?.data?.buckets || [];

    const results = buckets
      .map((b) => ({
        project: b.by['@project_id'],
        account: b.by['@account_id'],
        score: b.computes?.c0 ?? null,
        calls: b.computes?.c1 ?? 0,
      }))
      .filter((d) => d.score !== null)
      .sort((a, b) => b.score - a.score);

    res.json({ results, from, to, total: results.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Polyscore dashboard running on port ${PORT}`);
});
