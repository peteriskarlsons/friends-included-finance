const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

module.exports = async (req, res) => {
  if (req.method !== 'GET' || !secret || req.query?.key !== secret) return res.status(404).end();
  const webhookUrl = 'https://friends-included-finance-sigma.vercel.app/api/telegram';
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: secret })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) return res.status(502).json({ error: 'Telegram webhook setup failed' });
    return res.status(200).json({ ok: true, webhook: webhookUrl });
  } catch {
    return res.status(502).json({ error: 'Telegram webhook setup failed' });
  }
};

