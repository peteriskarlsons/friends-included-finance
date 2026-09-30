const api = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const token = process.env.TELEGRAM_BOT_TOKEN;

const headers = () => ({
  apikey: key,
  ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
});
const supa = async (path, options = {}) => {
  const res = await fetch(`${api}/rest/v1/${path}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!res.ok) throw new Error(`Database request failed (${res.status})`);
  return res.status === 204 ? null : res.json();
};
const reply = async (chat_id, text) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id, text }) });
const eur = n => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(n || 0);
const staffFor = async (userId) => (await supa(`staff?select=id,name,role&telegram_user_id=eq.${encodeURIComponent(userId)}&limit=1`))[0];

async function dashboard() {
  const [sales, expenses] = await Promise.all([supa('sales?select=amount,approved_commission,status,project'), supa('expenses?select=amount,project')]);
  const approved = sales.filter(x => x.status === 'approved');
  const income = approved.reduce((s, x) => s + Number(x.amount), 0);
  const commission = approved.reduce((s, x) => s + Number(x.approved_commission), 0);
  const cost = expenses.reduce((s, x) => s + Number(x.amount), 0);
  const projectResult = project => approved.filter(x => x.project === project).reduce((s, x) => s + Number(x.amount) - Number(x.approved_commission), 0) - expenses.filter(x => x.project === project).reduce((s, x) => s + Number(x.amount), 0);
  return `Friends Included dashboard\nApproved income: ${eur(income)}\nCommission: ${eur(commission)}\nRecorded expenses: ${eur(cost)}\nCompany result: ${eur(income - commission - cost)}\nProject A: ${eur(projectResult('A'))}\nProject B: ${eur(projectResult('B'))}`;
}

module.exports = async (req, res) => {
  if (!api || !key || !token) return res.status(503).json({ error: 'Telegram integration is not configured' });
  if (req.method === 'GET' && req.query?.setup === process.env.TELEGRAM_WEBHOOK_SECRET) {
    const webhookUrl = 'https://friends-included-finance-sigma.vercel.app/api/telegram';
    const setup = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET })
    });
    if (!setup.ok) return res.status(502).json({ error: 'Telegram webhook setup failed' });
    return res.status(200).json({ ok: true, webhook: webhookUrl });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (process.env.TELEGRAM_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid webhook secret' });
  const message = req.body?.message;
  if (!message?.text) return res.status(200).json({ ok: true });
  const chatId = message.chat.id;
  const userId = message.from.id;
  const [command, ...parts] = message.text.trim().split(/\s+/);
  try {
    if (command === '/start' || command === '/help') {
      await reply(chatId, 'Friends Included Finance\n/dashboard — current results\n/sale S06|A|Customer|1250|Description\n/expense E08|Travel|140|Description\nManagers: /approve S05\n\nYour Telegram user ID is ' + userId + '. Ask Svetlana to map it in the staff table before submitting entries.');
    } else if (command === '/dashboard') {
      await reply(chatId, await dashboard());
    } else {
      const staff = await staffFor(userId);
      if (!staff) await reply(chatId, 'Your account is not mapped to a Friends Included role yet. Ask Svetlana to add your Telegram user ID: ' + userId);
      else if (command === '/sale' && staff.role === 'sales') {
        const [reference, project, customer, amount, ...descriptionParts] = parts.join(' ').split('|').map(x => x.trim());
        const value = Number(amount);
        if (!/^S\d+$/.test(reference || '') || !['A', 'B'].includes(project) || !customer || !descriptionParts.join('|') || !(value > 0)) throw new Error('Use: /sale S06|A|Customer|1250|Description');
        await supa('sales', { method: 'POST', body: JSON.stringify({ reference, submitted_by: staff.id, customer, project, description: descriptionParts.join('|'), amount: value, proposed_commission: Math.round(value * 10) / 100, status: 'pending' }) });
        await reply(chatId, `${reference} was saved as pending manager approval.`);
      } else if (command === '/expense' && staff.role === 'expenses') {
        const [reference, category, amount, ...descriptionParts] = parts.join(' ').split('|').map(x => x.trim());
        const value = Number(amount);
        if (!/^E\d+$/.test(reference || '') || !category || !descriptionParts.join('|') || !(value > 0)) throw new Error('Use: /expense E08|Travel|140|Description');
        await supa('expenses', { method: 'POST', body: JSON.stringify({ reference, submitted_by: staff.id, category, description: descriptionParts.join('|'), amount: value, project: 'unallocated', allocation_status: 'awaiting_allocation' }) });
        await reply(chatId, `${reference} was recorded and awaits Svetlana’s allocation.`);
      } else if (command === '/approve' && staff.role === 'manager') {
        const reference = parts[0]?.toUpperCase();
        const sale = (await supa(`sales?select=id,amount,status&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
        if (!sale || sale.status !== 'pending') throw new Error('Only a pending sale can be approved.');
        const commission = Math.round(Number(sale.amount) * 10) / 100;
        await supa(`sales?id=eq.${sale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', approved_commission: commission, approved_by: staff.id, approved_at: new Date().toISOString() }) });
        await reply(chatId, `${reference} approved with a ${eur(commission)} commission.`);
      } else await reply(chatId, 'That command is unavailable for your role. Send /help for commands.');
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    await reply(chatId, error.message || 'Unable to process that request.');
    res.status(200).json({ ok: true });
  }
};

