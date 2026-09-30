const api = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const get = async path => {
  const res = await fetch(`${api}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error('Database unavailable');
  return res.json();
};
module.exports = async (_req, res) => {
  if (!api || !key) return res.status(503).json({ error: 'Backend not configured' });
  try {
    const [sales, expenses] = await Promise.all([get('sales?select=reference,customer,project,amount,approved_commission,status'), get('expenses?select=reference,description,project,amount,allocation_status')]);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ sales, expenses, googleSheet: process.env.GOOGLE_SHEET_URL || null, telegram: '@FriendsIncludedFinance29_bot' });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

