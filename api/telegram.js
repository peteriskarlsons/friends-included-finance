const { dashboardFor, earnings, isReady, loadLedger, requestReviewLink, resolveActor, reviewerChatForStaff, supa, telegramActorFor, validateSplit } = require('./lib');

const token = process.env.TELEGRAM_BOT_TOKEN;
const reply = async (chatId, text) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
const eur = value => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
const validTestReference = (reference, type) => new RegExp(`^TEST-${type}\\d+$`).test(reference || '');
const audit = (actor, entityType, entityReference, action, detail) => supa('audit_log', { method: 'POST', body: JSON.stringify({ actor_id: actor.id, entity_type: entityType, entity_reference: entityReference, action, detail }) }).catch(() => null);

async function dashboardText(staff) {
  const actor = staff.role === 'manager' ? await resolveActor('svetlana') : staff;
  const ledger = await loadLedger(actor);
  const summary = dashboardFor(actor, ledger);
  if (actor.role === 'manager') {
    const metric = Object.fromEntries(summary.metrics.map(item => [item.label, item.value]));
    return `Friends Included dashboard\nApproved income: ${eur(metric['Approved income'])}\nCommission: ${eur(metric['Commission expense'])}\nRecorded expenses: ${eur(metric['Recorded expenses'])}\nCompany result: ${eur(metric['Company result'])}\nProject A: ${eur(summary.projects.A.result)}\nProject B: ${eur(summary.projects.B.result)}\n\nFinal earned commission — Richard: ${eur(summary.individualEarnings.richard)} · Anastasia: ${eur(summary.individualEarnings.anastasia)} · Jean-Claude: ${eur(summary.individualEarnings.jean)}\n\nOriginal S05 and E07 are read-only. Pending labelled tests: ${summary.pendingSales.filter(sale => sale.is_test_record).map(sale => sale.reference).join(', ') || 'none'}.`;
  }
  if (actor.role === 'sales') {
    const metric = Object.fromEntries(summary.metrics.map(item => [item.label, item.value]));
    return `Friends Included — ${staff.name}\nYour approved sales: ${eur(metric['Your approved sales'])}\nYour pending sales: ${eur(metric['Your pending sales'])}\n${summary.metrics[2].label}: ${eur(summary.metrics[2].value)}\n\nOnly your submitted sales are shown.`;
  }
  const metric = Object.fromEntries(summary.metrics.map(item => [item.label, item.value]));
  return `Friends Included — ${staff.name}\nYour recorded expenses: ${eur(metric['Your recorded expenses'])}\nAllocated or overhead: ${eur(metric['Allocated or overhead'])}\nAwaiting allocation: ${eur(metric['Awaiting allocation'])}\n\nOnly your submitted expenses are shown.`;
}
function finalCommissionMessage(reference, pool, finalSplit) {
  const earned = earnings(pool, finalSplit);
  return `Manager decision — ${reference} approved. Final commission: Richard ${finalSplit.richard}% (${eur(earned.richard)}), Anastasia ${finalSplit.anastasia}% (${eur(earned.anastasia)}), Jean-Claude ${finalSplit.jean}% (${eur(earned.jean)}). Total pool: ${eur(pool)}.`;
}
async function notifyReviewLinkedStaff(staffId, text, currentChatId) {
  const chatId = await reviewerChatForStaff(staffId);
  if (chatId && String(chatId) !== String(currentChatId)) await reply(chatId, text);
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
  const chatId = message.chat.id;
  const userId = message.from.id;
  const [command, ...parts] = message.text.trim().split(/\s+/);
  try {
    if (command === '/review') {
      const request = await requestReviewLink(userId, chatId);
      const linked = request.status === 'linked' ? await telegramActorFor(userId) : null;
      const commandHint = linked?.role === 'expenses' ? '/test-expense' : linked?.role === 'sales' ? '/test-sale' : 'the assigned test command';
      const text = request.status === 'linked'
        ? `Your manager-controlled review role is already linked. Use /dashboard or ${commandHint}. Only a manager can switch the sales-test and Kevin expense-test roles.`
        : 'Your review request is recorded. A manager must choose either the sales-test or Kevin expense-test role in the web review route before test commands are enabled. This command does not grant manager access.';
      await reply(chatId, text);
      return res.status(200).json({ ok: true });
    }
    if (command === '/start' || command === '/help') {
      const linked = await telegramActorFor(userId);
      const roleHelp = linked?.role === 'sales'
        ? 'Your linked role: sales. Use /test-sale TEST-S01|A|Customer|1250|Description|50|30|20'
        : linked?.role === 'expenses'
          ? 'Your linked role: Kevin expenses. Use /test-expense TEST-E01|Travel|140|Description|A'
          : 'After a manager chooses your role: sales uses /test-sale TEST-S01|A|Customer|1250|Description|50|30|20; Kevin expenses uses /test-expense TEST-E01|Travel|140|Description|A.';
      await reply(chatId, `Friends Included Finance\n/dashboard — your server-filtered records\n/review — request a manager-controlled fictional test link\n${roleHelp}\nManagers: /approve TEST-S01|50|30|20 · /allocate TEST-E01|B\n\nOriginal S01–S05 and E01–E07 are read-only course records.`);
      return res.status(200).json({ ok: true });
    }
    const staff = await telegramActorFor(userId);
    if (!staff) {
      await reply(chatId, 'Your account is not linked to a fictional test employee. Send /review, then wait for a manager to approve the test link in the web review route.');
      return res.status(200).json({ ok: true });
    }
    if (command === '/dashboard') {
      await reply(chatId, await dashboardText(staff));
    } else if (command === '/test-sale' && staff.role === 'sales') {
      const [reference, project, customer, amount, description, richard, anastasia, jean] = parts.join(' ').split('|').map(value => value.trim());
      const value = Number(amount);
      const proposedSplit = validateSplit({ richard, anastasia, jean });
      if (!validTestReference(reference, 'S') || !['A', 'B'].includes(project) || !customer || !description || !(value > 0)) throw new Error('Use: /test-sale TEST-S01|A|Customer|1250|Description|50|30|20');
      const existing = await supa(`sales?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`);
      if (existing[0]) throw new Error('That test sale reference already exists.');
      const pool = Math.round(value * 10) / 100;
      await supa('sales', { method: 'POST', body: JSON.stringify({ reference, submitted_by: staff.id, customer, project, description, amount: value, proposed_commission: pool, proposed_commission_split: proposedSplit, status: 'pending', is_test_record: true }) });
      await audit(staff, 'sale', reference, 'labelled Telegram test sale submitted', { proposed_split: proposedSplit, commission_pool: pool });
      await reply(chatId, `${reference} saved as a labelled test sale. Proposed commission: Richard ${proposedSplit.richard}% · Anastasia ${proposedSplit.anastasia}% · Jean-Claude ${proposedSplit.jean}% (${eur(pool)} pool).`);
    } else if (command === '/test-expense' && staff.role === 'expenses') {
      const [reference, category, amount, description, proposedAllocation] = parts.join(' ').split('|').map(value => value.trim());
      const value = Number(amount);
      if (!validTestReference(reference, 'E') || !category || !description || !['A', 'B', 'overhead'].includes(proposedAllocation) || !(value > 0)) throw new Error('Use: /test-expense TEST-E01|Travel|140|Description|A');
      const existing = await supa(`expenses?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`);
      if (existing[0]) throw new Error('That test expense reference already exists.');
      const allocationStatus = proposedAllocation === 'overhead' ? 'recorded' : 'awaiting_allocation';
      const finalProject = proposedAllocation === 'overhead' ? 'overhead' : 'unallocated';
      await supa('expenses', { method: 'POST', body: JSON.stringify({ reference, submitted_by: staff.id, category, description, amount: value, proposed_allocation: proposedAllocation, project: finalProject, allocation_status: allocationStatus, is_test_record: true }) });
      await audit(staff, 'expense', reference, 'labelled Telegram test expense submitted', { proposed_allocation: proposedAllocation });
      await reply(chatId, `${reference} saved with proposed allocation ${proposedAllocation}.`);
    } else if (command === '/approve' && staff.role === 'manager') {
      const [reference, richard, anastasia, jean] = parts.join(' ').split('|').map(value => value.trim());
      const finalSplit = validateSplit({ richard, anastasia, jean });
      const sale = (await supa(`sales?select=id,amount,status,is_test_record,submitted_by&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
      if (!sale || sale.status !== 'pending') throw new Error('Only a pending labelled test sale can be approved.');
      if (!sale.is_test_record) throw new Error('Original Test 2 sales are read-only. Use a labelled TEST-S record.');
      const pool = Math.round(Number(sale.amount) * 10) / 100;
      const text = finalCommissionMessage(reference, pool, finalSplit);
      await supa(`sales?id=eq.${sale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', approved_commission: pool, final_commission_split: finalSplit, approved_by: staff.id, approved_at: new Date().toISOString() }) });
      await audit(staff, 'sale', reference, 'Telegram final commission decision recorded', { final_split: finalSplit, earned: earnings(pool, finalSplit), telegram_message: text });
      await reply(chatId, text);
      await notifyReviewLinkedStaff(sale.submitted_by, text, chatId);
    } else if (command === '/allocate' && staff.role === 'manager') {
      const [reference, project] = parts.join(' ').split('|').map(value => value.trim());
      if (!validTestReference(reference, 'E') || !['A', 'B', 'overhead'].includes(project)) throw new Error('Use: /allocate TEST-E01|A');
      const expense = (await supa(`expenses?select=id,allocation_status,is_test_record,submitted_by,proposed_allocation&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
      if (!expense || expense.allocation_status !== 'awaiting_allocation') throw new Error('Only an awaiting labelled test expense can be allocated.');
      if (!expense.is_test_record) throw new Error('Original Test 2 expenses are read-only. Use a labelled TEST-E record.');
      const text = `Manager decision — ${reference} final allocation: ${project}. Original proposal: ${expense.proposed_allocation}.`;
      await supa(`expenses?id=eq.${expense.id}`, { method: 'PATCH', body: JSON.stringify({ project, allocation_status: project === 'overhead' ? 'recorded' : 'allocated', allocated_by: staff.id, allocated_at: new Date().toISOString() }) });
      await audit(staff, 'expense', reference, 'Telegram final allocation decision recorded', { proposed_allocation: expense.proposed_allocation, final_allocation: project, telegram_message: text });
      await reply(chatId, text);
      await notifyReviewLinkedStaff(expense.submitted_by, text, chatId);
    } else {
      await reply(chatId, 'That command is unavailable for your linked role. Send /help for the labelled-test commands.');
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    await reply(chatId, error.message || 'Unable to process that request.');
    return res.status(200).json({ ok: true });
  }
};

