const { isReady, resolveActor, supa } = require('./lib');
const bodyFor = req => typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
const validReference = (reference, prefix) => new RegExp(`^${prefix}\\d+$`).test(reference || '');
const audit = (actor, entityType, entityReference, action, detail) => supa('audit_log', { method: 'POST', body: JSON.stringify({ actor_id: actor.id, entity_type: entityType, entity_reference: entityReference, action, detail }) }).catch(() => null);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isReady()) return res.status(503).json({ error: 'Shared ledger is not configured' });
  try {
    const input = bodyFor(req); const actor = await resolveActor(input.as); const action = input.action;
    if (action === 'sale') {
      if (actor.role !== 'sales') throw new Error('Only sales employees can submit sales');
      const reference = String(input.reference || '').trim().toUpperCase(), amount = Number(input.amount), customer = String(input.customer || '').trim(), description = String(input.description || '').trim(), project = String(input.project || '');
      if (!validReference(reference, 'S') || !customer || !description || !['A', 'B'].includes(project) || !(amount > 0)) throw new Error('Use a unique S-reference, customer, project, description, and positive amount');
      const [saleMatch, expenseMatch] = await Promise.all([supa(`sales?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`), supa(`expenses?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`)]);
      if (saleMatch[0] || expenseMatch[0]) throw new Error('That reference already exists');
      await supa('sales', { method: 'POST', body: JSON.stringify({ reference, submitted_by: actor.id, customer, project, description, amount, proposed_commission: Math.round(amount * 10) / 100, status: 'pending' }) });
      await audit(actor, 'sale', reference, 'submitted for manager approval', { project, amount });
      return res.status(201).json({ ok: true, message: `${reference} is now pending manager approval.` });
    }
    if (action === 'expense') {
      if (actor.role !== 'expenses') throw new Error('Only the expenses employee can submit expenses');
      const reference = String(input.reference || '').trim().toUpperCase(), amount = Number(input.amount), category = String(input.category || '').trim(), description = String(input.description || '').trim(), project = String(input.project || '');
      if (!validReference(reference, 'E') || !category || !description || !['A', 'B', 'overhead'].includes(project) || !(amount > 0)) throw new Error('Use a unique E-reference, category, allocation, description, and positive amount');
      const [saleMatch, expenseMatch] = await Promise.all([supa(`sales?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`), supa(`expenses?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`)]);
      if (saleMatch[0] || expenseMatch[0]) throw new Error('That reference already exists');
      const allocationStatus = project === 'overhead' ? 'recorded' : 'awaiting_allocation';
      await supa('expenses', { method: 'POST', body: JSON.stringify({ reference, submitted_by: actor.id, category, description, amount, project, allocation_status: allocationStatus }) });
      await audit(actor, 'expense', reference, 'submitted', { project, amount, allocationStatus });
      return res.status(201).json({ ok: true, message: project === 'overhead' ? `${reference} was recorded as company overhead.` : `${reference} is awaiting Svetlana’s allocation.` });
    }
    if (action === 'approveSale') {
      if (actor.role !== 'manager') throw new Error('Only Svetlana can approve sales');
      const reference = String(input.reference || '').trim().toUpperCase(); const sale = (await supa(`sales?select=id,amount,status&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
      if (!sale || sale.status !== 'pending') throw new Error('Only a pending sale can be approved');
      const commission = Math.round(Number(sale.amount) * 10) / 100;
      await supa(`sales?id=eq.${sale.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', approved_commission: commission, approved_by: actor.id, approved_at: new Date().toISOString() }) });
      await audit(actor, 'sale', reference, 'approved', { commission });
      return res.status(200).json({ ok: true, message: `${reference} was approved with a €${commission.toFixed(2)} commission pool.` });
    }
    if (action === 'allocateExpense') {
      if (actor.role !== 'manager') throw new Error('Only Svetlana can allocate expenses');
      const reference = String(input.reference || '').trim().toUpperCase(), project = String(input.project || '');
      if (!['A', 'B', 'overhead'].includes(project)) throw new Error('Choose Project A, Project B, or company overhead');
      const expense = (await supa(`expenses?select=id,allocation_status&reference=eq.${encodeURIComponent(reference)}&limit=1`))[0];
      if (!expense || expense.allocation_status !== 'awaiting_allocation') throw new Error('Only an awaiting expense can be allocated');
      const allocationStatus = project === 'overhead' ? 'recorded' : 'allocated';
      await supa(`expenses?id=eq.${expense.id}`, { method: 'PATCH', body: JSON.stringify({ project, allocation_status: allocationStatus, allocated_by: actor.id, allocated_at: new Date().toISOString() }) });
      await audit(actor, 'expense', reference, 'allocation confirmed', { project, allocationStatus });
      return res.status(200).json({ ok: true, message: `${reference} was allocated to ${project === 'overhead' ? 'company overhead' : `Project ${project}`}.` });
    }
    throw new Error('Unknown shared-ledger action');
  } catch (error) { return res.status(400).json({ error: error.message || 'Unable to update shared ledger' }); }
};

