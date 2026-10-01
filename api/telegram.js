const { dashboardFor, isReady, loadLedger, resolveActor, supa } = require('./lib');

const token = process.env.TELEGRAM_BOT_TOKEN;
const reply = async (chatId, text) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text })
});
const eur = value => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
const staffFor = async userId => (await supa(`staff?select=id,name,role,telegram_user_id,telegram_chat_id&telegram_user_id=eq.${encodeURIComponent(userId)}&limit=1`))[0];
const reviewName = 'Course reviewer (fictional)';

async function provisionReviewer(userId, chatId) {
  const rows = await supa(`staff?select=id,name,role,telegram_user_id&name=eq.${encodeURIComponent(reviewName)}&limit=1`);
  const reviewer = rows[0];
  if (reviewer && reviewer.telegram_user_id && String(reviewer.telegram_user_id) !== String(userId)) throw new Error('The fictional reviewer account is already active. Use /review.html for the web test route.');
  if (reviewer) {
    await supa(`staff?id=eq.${reviewer.id}`, { method: 'PATCH', body: JSON.stringify({ telegram_user_id: userId, telegram_chat_id: chatId }) });
    return { ...reviewer, role: 'manager' };
  }
  const created = await supa('staff', { method: 'POST', body: JSON.stringify({ name: reviewName, role: 'manager', telegram_user_id: userId, telegram_chat_id: chatId }) });
  return created[0];
}

async function dashboardText(staff) {
  const actor = staff.role === 'manager' ? await resolveActor('svetlana') : { ...staff, key: staff.role === 'sales' ? 'richard' : 'kevin' };
  const ledger = await loadLedger(actor);
  const summary = dashboardFor(actor, ledger);
  if (actor.role === 'manager') {
    const metric = Object.fromEntries(summary.metrics.map(item => [item.label, item.value]));
    return `Friends Included dashboard\nApproved income: ${eur(metric['Approved income'])}\nCommission: ${eur(metric['Commission expense'])}\nRecorded expenses: ${eur(metric['Recorded expenses'])}\nCompany result: ${eur(metric['Company result'])}\nProject A: ${eur(summary.projects.A.result)}\nProject B: ${eur(summary.projects.B.result)}\n\nPending: ${summary.pendingSales.map(sale => sale.reference).join(', ') || 'none'} · Awaiting: ${summary.awaitingExpenses.map(expense => expense.reference).join(', ') || 'none'}`;
  }
  if (actor.role === 'sales') {
    const metric = Object.fromEntries(summary.metrics.map(item => [item.label, item.value]));
    return `Friends Included — ${staff.name}\nYour approved sales: ${eur(metric['Your approved sales'])}\nYour pending sales: ${eur(metric['Your pending sales'])}\nApproved commission pool: ${eur(metric['Approved commission pool'])}\n\nOnly your submitted sales are shown.`;
  }
  const metric = Object.fromEntries(summary.metrics.map(item => [item.label, item.value]));
  return `Friends Included — ${staff.name}\nYour recorded expenses: ${eur(metric['Your recorded expenses'])}\nAllocated or overhead: ${eur(metric['Allocated or overhead'])}\nAwaiting allocation: ${eur(metric['Awaiting allocation'])}\n\nOnly your submitted expenses are shown.`;
}

module.exports = async (req, res) => {
  if (!isReady() || !token) return res.status(503).json({ error: 'Telegram integration is not configured' });
  if (req.method === 'GET' && req.query?.setup === process.env.TELEGRAM_WEBHOOK_SECRET) {
    const webhookUrl = 'https://friends-included-finance-sigma.vercel.app/api/telegram';
    const setup = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: webhookUrl, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET }) });
    if (!setup.ok) return res.status(502).json({ error: 'Telegram webhook setup failed' });
    return res.status(200).json({ ok: true, webhook: webhookUrl });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (process.env.TELEGRAM_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid webhook secret' });
  const message = req.body?.message;
  if (!message?.text) return res.status(200).json({ ok: true });
  const chatId = message.chat.id, userId = message.from.id;
  const [command, ...parts] = message.text.trim().split(/\s+/);
  try {
    if (command === '/review') {
      await provisionReviewer(userId, chatId);
      await reply(chatId, 'Fictional reviewer manager access is active. You can now use /dashboard, /approve S05, and /allocate E07|A. This account is only for the course review dataset.');
    } else if (command === '/start' || command === '/help') {
      await reply(chatId, 'Friends Included Finance\n/dashboard — your server-filtered records\n/sale S06|A|Customer|1250|Description\n/expense E08|Travel|140|Description\nManagers: /approve S05 · /allocate E07|A\n\nFor the self-contained fictional course review, send /review.');
    } else {
      const staff = await staffFor(userId);
      if (!staff) {
        await reply(chatId, 'Your account is not mapped to a staff role. For the fictional course-review manager route, send /review.');
      } else if (command === '/dashboard') {
        await reply(chatId, await dashboardText(staff));
      } else if (command === '/sale' && staff.role === 'sales') {
        const [reference, project, customer, amount, ...descriptionParts] = parts.join(' ').split('|').map(value => value.trim());
        const value = Number(amount);
        if (!/^S\d+$/.test(reference || '') || !['A', 'B'].includes(project) || !customer || !descriptionParts.join('|') || !(value > 0)) throw new Error('Use: /sale S06|A|Customer|1250|Description');
        const existing = await supa(`sales?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`);
        if (existing[0]) throw new Error('That sale reference already exists.');
        await supa('sales', { method: 'POST', body: JSON.stringify({ reference, submitted_by: staff.id, customer, project, description: descriptionParts.join('|'), amount: value, proposed_commission: Math.round(value * 10) / 100, status: 'pending' }) });
        await reply(chatId, `${reference} was saved in the shared ledger as pending manager approval.`);
      } else if (command === '/expense' && staff.role === 'expenses') {
        const [reference, category, amount, ...descriptionParts] = parts.join(' ').split('|').map(value => value.trim());
        const value = Number(amount);
        if (!/^E\d+$/.test(reference || '') || !category || !descriptionParts.join('|') || !(value > 0)) throw new Error('Use: /expense E08|Travel|140|Description');
        const existing = await supa(`expenses?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`);
        if (existing[0]) throw new Error('That expense reference already exists.');
        await supa('expenses', { method: 'POST', body: JSON.stringify({ reference, submitted_by: staff.id, category, description: descriptionParts.join('|'), amount: value, project: 'unallocated', allocation_status: 'awaiting_allocation' }) });
        await reply(chatId, `${reference} was recorded in the shared ledger and awaits allocation.`);
      } else if (command === '/approve' && staff.role === 'manager') {
        const reference = parts[0]?.toUpperCase();
        const sale = (await supa(`sales?select=id,amount,status&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
        if (!sale || sale.status !== 'pending') throw new Error('Only a pending sale can be approved.');
        const commission = Math.round(Number(sale.amount) * 10) / 100;
        await supa(`sales?id=eq.${sale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', approved_commission: commission, approved_by: staff.id, approved_at: new Date().toISOString() }) });
        await reply(chatId, `${reference} approved in the shared ledger with a ${eur(commission)} commission pool.`);
      } else if (command === '/allocate' && staff.role === 'manager') {
        const [reference, project] = parts.join(' ').split('|').map(value => value.trim());
        if (!/^E\d+$/.test(reference || '') || !['A', 'B', 'overhead'].includes(project)) throw new Error('Use: /allocate E07|A');
        const expense = (await supa(`expenses?select=id,allocation_status&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
        if (!expense || expense.allocation_status !== 'awaiting_allocation') throw new Error('Only an awaiting expense can be allocated.');
        await supa(`expenses?id=eq.${expense.id}`, { method: 'PATCH', body: JSON.stringify({ project, allocation_status: project === 'overhead' ? 'recorded' : 'allocated', allocated_by: staff.id, allocated_at: new Date().toISOString() }) });
        await reply(chatId, `${reference} was allocated to ${project === 'overhead' ? 'company overhead' : `Project ${project}`} in the shared ledger.`);
      } else {
        await reply(chatId, 'That command is unavailable for your role. Send /help for commands.');
      }
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    await reply(chatId, error.message || 'Unable to process that request.');
    return res.status(200).json({ ok: true });
  }
};

