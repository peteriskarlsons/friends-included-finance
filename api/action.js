const { earnings, inspectExpenseSheetSync, isReady, loadLedger, resolveActor, reviewerChatForStaff, staffByName, supa, validateSplit } = require('./lib');

const bodyFor = req => typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
const validTestReference = (reference, prefix) => new RegExp(`^TEST-${prefix}\\d+$`).test(reference || '');
const audit = (actor, entityType, entityReference, action, detail) => supa('audit_log', { method: 'POST', body: JSON.stringify({ actor_id: actor.id, entity_type: entityType, entity_reference: entityReference, action, detail }) }).catch(() => null);
const eur = value => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
  return response.ok;
}
function finalCommissionMessage(reference, pool, finalSplit) {
  const earned = earnings(pool, finalSplit);
  return `Manager decision — ${reference} approved. Final commission: Richard ${finalSplit.richard}% (${eur(earned.richard)}), Anastasia ${finalSplit.anastasia}% (${eur(earned.anastasia)}), Jean-Claude ${finalSplit.jean}% (${eur(earned.jean)}). Total pool: ${eur(pool)}.`;
}
async function notifyLinkedReviewer(staffId, text) {
  const chatId = await reviewerChatForStaff(staffId);
  return sendTelegram(chatId, text);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isReady()) return res.status(503).json({ error: 'Shared ledger is not configured' });
  try {
    const input = bodyFor(req);
    const action = input.action;
    if (action === 'createWebReviewRequest') {
      const label = String(input.label || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{2,47}$/.test(label)) throw new Error('Use a 3–48 character fictional review label (letters, numbers, spaces, dots, hyphens, or underscores).');
      const request = (await supa('review_requests', { method: 'POST', body: JSON.stringify({ telegram_user_id: -Date.now(), telegram_chat_id: 0, label: `Web review: ${label}` }) }))[0];
      return res.status(201).json({ ok: true, requestId: request.id, message: 'Fictional review request created. Open the Svetlana manager view and choose either the sales-test or Kevin expense-test role.' });
    }
    const actor = await resolveActor(input.as);
    if (action === 'linkReviewRequest') {
      if (actor.role !== 'manager') throw new Error('Only the fictional manager can link a review request.');
      const requestId = String(input.requestId || '');
      const request = (await supa(`review_requests?select=id,status,linked_staff_id&id=eq.${encodeURIComponent(requestId)}&limit=1`))[0];
      if (!request || !['requested', 'linked'].includes(request.status)) throw new Error('That review-link request is unavailable.');
      const linkedRole = String(input.linkedRole || 'sales');
      const targets = { sales: 'Fictional Test Employee', expenses: 'Kevin' };
      if (!targets[linkedRole]) throw new Error('Choose the sales-test or Kevin expense-test role.');
      const target = await staffByName(targets[linkedRole]);
      if (target.role !== linkedRole) throw new Error('The selected fictional review role is unavailable.');
      await supa(`review_requests?id=eq.${request.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'linked', linked_staff_id: target.id, linked_by: actor.id, linked_at: new Date().toISOString() }) });
      const actionLabel = request.status === 'linked' ? 'switched fictional review role' : 'linked fictional review role';
      await audit(actor, 'staff', `review-${request.id}`, actionLabel, { linked_role: target.role, staff_name: target.name });
      const command = linkedRole === 'sales' ? 'TEST-S' : 'TEST-E';
      return res.status(200).json({ ok: true, message: `The reviewer is linked to ${target.name}'s ${target.role} role. They can now submit only labelled ${command} records; this never grants manager access.` });
    }
    if (action === 'sale') {
      if (actor.role !== 'sales') throw new Error('Only sales employees can submit test sales.');
      const reference = String(input.reference || '').trim().toUpperCase();
      const amount = Number(input.amount);
      const customer = String(input.customer || '').trim();
      const description = String(input.description || '').trim();
      const project = String(input.project || '');
      const proposedSplit = validateSplit(input.proposedSplit);
      if (!validTestReference(reference, 'S') || !customer || !description || !['A', 'B'].includes(project) || !(amount > 0)) throw new Error('Use a new TEST-S reference, customer, project, description, positive amount, and a 100% proposed split.');
      const [saleMatch, expenseMatch] = await Promise.all([supa(`sales?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`), supa(`expenses?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`)]);
      if (saleMatch[0] || expenseMatch[0]) throw new Error('That test reference already exists.');
      const pool = Math.round(amount * 10) / 100;
      await supa('sales', { method: 'POST', body: JSON.stringify({ reference, submitted_by: actor.id, customer, project, description, amount, proposed_commission: pool, proposed_commission_split: proposedSplit, status: 'pending', is_test_record: true }) });
      await audit(actor, 'sale', reference, 'labelled test sale submitted', { proposed_split: proposedSplit, commission_pool: pool });
      return res.status(201).json({ ok: true, message: `${reference} is a labelled test sale awaiting a manager decision. Proposed pool: ${eur(pool)}.` });
    }
    if (action === 'expense') {
      if (actor.role !== 'expenses') throw new Error('Only the expenses employee can submit test expenses.');
      const reference = String(input.reference || '').trim().toUpperCase();
      const amount = Number(input.amount);
      const category = String(input.category || '').trim();
      const description = String(input.description || '').trim();
      const proposedAllocation = String(input.proposedAllocation || '');
      if (!validTestReference(reference, 'E') || !category || !description || !['A', 'B', 'overhead'].includes(proposedAllocation) || !(amount > 0)) throw new Error('Use a new TEST-E reference, category, proposed allocation, description, and positive amount.');
      const [saleMatch, expenseMatch] = await Promise.all([supa(`sales?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`), supa(`expenses?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`)]);
      if (saleMatch[0] || expenseMatch[0]) throw new Error('That test reference already exists.');
      const allocationStatus = proposedAllocation === 'overhead' ? 'recorded' : 'awaiting_allocation';
      const finalProject = proposedAllocation === 'overhead' ? 'overhead' : 'unallocated';
      await supa('expenses', { method: 'POST', body: JSON.stringify({ reference, submitted_by: actor.id, category, description, amount, proposed_allocation: proposedAllocation, project: finalProject, allocation_status: allocationStatus, is_test_record: true }) });
      await audit(actor, 'expense', reference, 'labelled test expense submitted', { proposed_allocation: proposedAllocation, allocation_status: allocationStatus });
      return res.status(201).json({ ok: true, message: proposedAllocation === 'overhead' ? `${reference} was recorded as labelled test overhead.` : `${reference} is a labelled test expense awaiting final allocation.` });
    }
    if (action === 'approveSale') {
      if (actor.role !== 'manager') throw new Error('Only the fictional manager can approve labelled test sales.');
      const reference = String(input.reference || '').trim().toUpperCase();
      const sale = (await supa(`sales?select=id,amount,status,is_test_record,submitted_by&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
      if (!sale || sale.status !== 'pending') throw new Error('Only a pending sale can be approved.');
      if (!sale.is_test_record) throw new Error('Original Test 2 sales are locked. Create and approve a labelled TEST-S record instead.');
      const finalSplit = validateSplit(input.finalSplit);
      const pool = Math.round(Number(sale.amount) * 10) / 100;
      const telegramMessage = finalCommissionMessage(reference, pool, finalSplit);
      await supa(`sales?id=eq.${sale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', approved_commission: pool, final_commission_split: finalSplit, approved_by: actor.id, approved_at: new Date().toISOString() }) });
      const sent = await notifyLinkedReviewer(sale.submitted_by, telegramMessage);
      await audit(actor, 'sale', reference, 'labelled test commission decision recorded', { final_split: finalSplit, earned: earnings(pool, finalSplit), telegram_message: telegramMessage, telegram_sent: sent });
      return res.status(200).json({ ok: true, message: `${reference} approved. ${telegramMessage}${sent ? ' A Telegram receipt was sent.' : ''}` });
    }
    if (action === 'allocateExpense') {
      if (actor.role !== 'manager') throw new Error('Only the fictional manager can allocate labelled test expenses.');
      const reference = String(input.reference || '').trim().toUpperCase();
      const project = String(input.project || '');
      if (!['A', 'B', 'overhead'].includes(project)) throw new Error('Choose Project A, Project B, or company overhead.');
      const expense = (await supa(`expenses?select=id,allocation_status,is_test_record,submitted_by,proposed_allocation&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
      if (!expense || expense.allocation_status !== 'awaiting_allocation') throw new Error('Only an awaiting expense can be allocated.');
      if (!expense.is_test_record) throw new Error('Original Test 2 expenses are locked. Create and allocate a labelled TEST-E record instead.');
      const allocationStatus = project === 'overhead' ? 'recorded' : 'allocated';
      const telegramMessage = `Manager decision — ${reference} allocation changed from ${expense.proposed_allocation} to ${project}.`;
      await supa(`expenses?id=eq.${expense.id}`, { method: 'PATCH', body: JSON.stringify({ project, allocation_status: allocationStatus, allocated_by: actor.id, allocated_at: new Date().toISOString() }) });
      const sent = await notifyLinkedReviewer(expense.submitted_by, telegramMessage);
      await audit(actor, 'expense', reference, 'labelled test allocation decision recorded', { proposed_allocation: expense.proposed_allocation, final_allocation: project, telegram_message: telegramMessage, telegram_sent: sent });
      return res.status(200).json({ ok: true, message: `${reference} final allocation is ${project}.${sent ? ' A Telegram receipt was sent.' : ''}` });
    }
    if (action === 'retryExpenseSheetCheck') {
      if (actor.role !== 'manager') throw new Error('Only the fictional manager can retry a shared Sheet check.');
      const reference = String(input.reference || '').trim().toUpperCase();
      if (!validTestReference(reference, 'E')) throw new Error('Choose an existing labelled TEST-E reference.');
      const ledger = await loadLedger(actor);
      const expense = ledger.expenses.find(item => item.reference === reference);
      if (!expense || !expense.is_test_record) throw new Error('Only an existing labelled TEST-E record can be retried. No new record was created.');
      const sync = await inspectExpenseSheetSync(ledger.expenses, reference);
      await audit(actor, 'expense', reference, 'shared Sheet sync check retried', { state: sync.state, checked_at: sync.checkedAt, reason: sync.reason || sync.message || '' });
      const message = sync.state === 'synced'
        ? `${reference} is confirmed in Live Expenses with its current decision.`
        : sync.state === 'pending'
          ? `${reference} remains one shared record. Google Sheets has not confirmed its latest data yet; use Finance sync → Retry Live Expenses now in the Sheet, then retry this check.`
          : `${reference} was not recreated. The Google Sheets export check failed: ${sync.reason}`;
      return res.status(200).json({ ok: true, sync, message });
    }
    throw new Error('Unknown shared-ledger action.');
  } catch (error) { return res.status(400).json({ error: error.message || 'Unable to update shared ledger' }); }
};

