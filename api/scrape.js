module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });

  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const ARGENPROP_ACTOR = 'fBSvbyQ5dHGq5efbX';

  try {
    const startRes = await fetch(`https://api.apify.com/v2/acts/${ARGENPROP_ACTOR}/runs?token=${APIFY_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url }], maxItems: 1 })
    });
    const startData = await startRes.json();
    const runId = startData.data?.id;
    if (!runId) return res.status(500).json({ error: 'No se pudo iniciar el scraping' });

    let result = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      const statusData = await statusRes.json();
      const status = statusData.data?.status;
      if (status === 'SUCCEEDED') {
        const datasetId = statusData.data?.defaultDatasetId;
        const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
        const items = await itemsRes.json();
        result = items[0];
        break;
      } else if (status === 'FAILED' || status === 'ABORTED') {
        return res.status(500).json({ error: 'Scraping fallido' });
      }
    }

    if (!result) return res.status(504).json({ error: 'Timeout' });
    return res.status(200).json(result);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
