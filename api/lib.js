const api = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const actorNames = {
  richard: 'Richard', anastasia: 'Anastasia', jean: 'Jean-Claude', kevin: 'Kevin', svetlana: 'Svetlana'
};
const splitPeople = ['richard', 'anastasia', 'jean'];
const displayNames = { richard: 'Richard', anastasia: 'Anastasia', jean: 'Jean-Claude' };

const isReady = () => Boolean(api && key);
const headers = () => ({
  apikey: key,
  ...(key && key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
  'Content-Type': 'application/json', Prefer: 'return=representation'
});
async function supa(path, options = {}) {
  if (!isReady()) throw new Error('Shared ledger is not configured');
  const response = await fetch(`${api}/rest/v1/${path}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Shared ledger request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

const round = value => Math.round(Number(value || 0) * 100) / 100;
const json = value => { if (!value) return null; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return null; } };
function split(value) {
  const raw = json(value) || {};
  return Object.fromEntries(splitPeople.map(person => [person, Number(raw[person] || 0)]));
}
function validateSplit(value) {
  const normalized = split(value);
  const total = round(splitPeople.reduce((sum, person) => sum + normalized[person], 0));
  if (splitPeople.some(person => !Number.isFinite(normalized[person]) || normalized[person] < 0 || normalized[person] > 100) || total !== 100) {
    throw new Error('Richard, Anastasia, and Jean-Claude commission shares must be 0–100 and total exactly 100%.');
  }
  return normalized;
}
function earnings(pool, finalSplit) {
  const shares = split(finalSplit);
  return Object.fromEntries(splitPeople.map(person => [person, round(Number(pool || 0) * shares[person] / 100)]));
}
function staffSplitKey(name) {
  const lowered = String(name || '').toLowerCase();
  if (lowered.startsWith('richard')) return 'richard';
  if (lowered.startsWith('anastasia')) return 'anastasia';
  if (lowered.startsWith('jean-claude')) return 'jean';
  return null;
}
function decorateSale(sale) {
  const proposedSplit = split(sale.proposed_commission_split);
  const finalSplit = sale.final_commission_split ? split(sale.final_commission_split) : null;
  return { ...sale, is_test_record: Boolean(sale.is_test_record), proposed_split: proposedSplit, final_split: finalSplit, final_earnings: finalSplit ? earnings(sale.approved_commission, finalSplit) : null };
}
const decorateExpense = expense => ({ ...expense, is_test_record: Boolean(expense.is_test_record) });

async function resolveActor(keyName) {
  const keyNameNormalized = String(keyName || 'richard').toLowerCase();
  const name = actorNames[keyNameNormalized];
  if (!name) throw new Error('Unknown fictional review account');
  const rows = await supa(`staff?select=id,name,role&name=eq.${encodeURIComponent(name)}&limit=1`);
  if (!rows[0]) throw new Error('Review account is unavailable');
  return { ...rows[0], key: keyNameNormalized };
}
async function staffByName(name) {
  const rows = await supa(`staff?select=id,name,role&name=eq.${encodeURIComponent(name)}&limit=1`);
  if (!rows[0]) throw new Error('Required fictional staff account is unavailable');
  return rows[0];
}
async function loadLedger(actor) {
  const salesFields = 'id,reference,submitted_by,customer,project,description,amount,proposed_commission,approved_commission,proposed_commission_split,final_commission_split,status,is_test_record,submitted_at,approved_at,approved_by';
  const expenseFields = 'id,reference,submitted_by,description,category,amount,project,proposed_allocation,allocation_status,is_test_record,submitted_at,allocated_at,allocated_by';
  if (actor.role === 'manager') {
    const [staff, sales, expenses] = await Promise.all([supa('staff?select=id,name,role'), supa(`sales?select=${salesFields}&order=reference.asc`), supa(`expenses?select=${expenseFields}&order=reference.asc`)]);
    const names = Object.fromEntries(staff.map(person => [person.id, person.name]));
    return { sales: sales.map(sale => decorateSale({ ...sale, submitted_by_name: names[sale.submitted_by] || 'Unknown', approved_by_name: names[sale.approved_by] || '' })), expenses: expenses.map(expense => decorateExpense({ ...expense, submitted_by_name: names[expense.submitted_by] || 'Unknown', allocated_by_name: names[expense.allocated_by] || '' })) };
  }
  if (actor.role === 'sales') {
    const sales = await supa(`sales?select=${salesFields}&submitted_by=eq.${actor.id}&order=reference.asc`);
    return { sales: sales.map(sale => decorateSale({ ...sale, submitted_by_name: actor.name })), expenses: [] };
  }
  const expenses = await supa(`expenses?select=${expenseFields}&submitted_by=eq.${actor.id}&order=reference.asc`);
  return { sales: [], expenses: expenses.map(expense => decorateExpense({ ...expense, submitted_by_name: actor.name })) };
}
async function loadReviewRequests() { return supa('review_requests?select=id,telegram_user_id,telegram_chat_id,status,requested_at,label&status=eq.requested&order=requested_at.asc'); }
async function requestReviewLink(userId, chatId) {
  const rows = await supa(`review_requests?select=id,status,linked_staff_id&telegram_user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  const existing = rows[0];
  if (existing?.status === 'linked') return existing;
  if (existing) return (await supa(`review_requests?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify({ telegram_chat_id: chatId, status: 'requested', requested_at: new Date().toISOString() }) }))[0];
  return (await supa('review_requests', { method: 'POST', body: JSON.stringify({ telegram_user_id: userId, telegram_chat_id: chatId, label: 'Course review test' }) }))[0];
}
async function telegramActorFor(userId) {
  const direct = (await supa(`staff?select=id,name,role,telegram_user_id,telegram_chat_id&telegram_user_id=eq.${encodeURIComponent(userId)}&limit=1`))[0];
  if (direct) return { ...direct, source: 'staff' };
  const request = (await supa(`review_requests?select=id,status,linked_staff_id,telegram_chat_id&telegram_user_id=eq.${encodeURIComponent(userId)}&limit=1`))[0];
  if (!request || request.status !== 'linked' || !request.linked_staff_id) return null;
  const linked = (await supa(`staff?select=id,name,role&id=eq.${request.linked_staff_id}&limit=1`))[0];
  return linked ? { ...linked, source: 'review_link', review_request_id: request.id, telegram_chat_id: request.telegram_chat_id } : null;
}
async function reviewerChatForStaff(staffId) {
  const rows = await supa(`review_requests?select=telegram_chat_id&linked_staff_id=eq.${staffId}&status=eq.linked&limit=1`);
  return rows[0]?.telegram_chat_id || null;
}

function dashboardFor(actor, ledger) {
  const approved = ledger.sales.filter(sale => sale.status === 'approved');
  const pendingSales = ledger.sales.filter(sale => sale.status === 'pending');
  const awaitingExpenses = ledger.expenses.filter(expense => expense.allocation_status === 'awaiting_allocation');
  if (actor.role === 'manager') {
    const income = round(approved.reduce((total, sale) => total + Number(sale.amount), 0));
    const commission = round(approved.reduce((total, sale) => total + Number(sale.approved_commission), 0));
    const expenseTotal = round(ledger.expenses.reduce((total, expense) => total + Number(expense.amount), 0));
    const project = name => {
      const projectSales = approved.filter(sale => sale.project === name);
      const saleIncome = round(projectSales.reduce((total, sale) => total + Number(sale.amount), 0));
      const saleCommission = round(projectSales.reduce((total, sale) => total + Number(sale.approved_commission), 0));
      const projectExpenses = round(ledger.expenses.filter(expense => expense.project === name).reduce((total, expense) => total + Number(expense.amount), 0));
      return { income: saleIncome, commission: saleCommission, expenses: projectExpenses, result: round(saleIncome - saleCommission - projectExpenses) };
    };
    const individualEarnings = Object.fromEntries(splitPeople.map(person => [person, round(approved.reduce((total, sale) => total + Number(sale.final_earnings?.[person] || 0), 0))]));
    return { visibility: 'manager', metrics: [
      { label: 'Approved income', value: income, detail: 'Approved sales only' },
      { label: 'Commission expense', value: commission, detail: '10% pool with final individual shares' },
      { label: 'Recorded expenses', value: expenseTotal, detail: 'Includes E07 while awaiting allocation' },
      { label: 'Company result', value: round(income - commission - expenseTotal), detail: 'Shared-company view', kind: 'result' }
    ], projects: { A: project('A'), B: project('B') }, individualEarnings, pendingSales, awaitingExpenses };
  }
  if (actor.role === 'sales') {
    const approvedIncome = round(approved.reduce((total, sale) => total + Number(sale.amount), 0));
    const pendingIncome = round(pendingSales.reduce((total, sale) => total + Number(sale.amount), 0));
    const person = staffSplitKey(actor.name);
    const earned = person ? round(approved.reduce((total, sale) => total + Number(sale.final_earnings?.[person] || 0), 0)) : round(approved.reduce((total, sale) => total + Number(sale.approved_commission || 0), 0));
    return { visibility: 'employee', metrics: [
      { label: 'Your approved sales', value: approvedIncome, detail: `${approved.length} approved record${approved.length === 1 ? '' : 's'}` },
      { label: 'Your pending sales', value: pendingIncome, detail: `${pendingSales.length} awaiting a manager` },
      { label: person ? 'Your earned commission' : 'Approved commission pool', value: earned, detail: person ? 'Final share from your server-filtered sales' : '10% pool on your approved test sale' }
    ], projects: null, individualEarnings: null, pendingSales, awaitingExpenses: [] };
  }
  const expenseTotal = round(ledger.expenses.reduce((total, expense) => total + Number(expense.amount), 0));
  const allocatedTotal = round(ledger.expenses.filter(expense => expense.allocation_status !== 'awaiting_allocation').reduce((total, expense) => total + Number(expense.amount), 0));
  const awaitingTotal = round(awaitingExpenses.reduce((total, expense) => total + Number(expense.amount), 0));
  return { visibility: 'employee', metrics: [
    { label: 'Your recorded expenses', value: expenseTotal, detail: `${ledger.expenses.length} submitted record${ledger.expenses.length === 1 ? '' : 's'}` },
    { label: 'Allocated or overhead', value: allocatedTotal, detail: 'Manager-confirmed or company overhead' },
    { label: 'Awaiting allocation', value: awaitingTotal, detail: `${awaitingExpenses.length} record${awaitingExpenses.length === 1 ? '' : 's'} awaiting a manager` }
  ], projects: null, individualEarnings: null, pendingSales: [], awaitingExpenses };
}

function csvCell(value) { const text = value === null || value === undefined ? '' : String(value); return /[\",\n]/.test(text) ? `\"${text.replace(/\"/g, '\"\"')}\"` : text; }
function csv(rows) { return rows.map(row => row.map(csvCell).join(',')).join('\n'); }

module.exports = { actorNames, csv, dashboardFor, displayNames, earnings, isReady, loadLedger, loadReviewRequests, requestReviewLink, resolveActor, reviewerChatForStaff, round, split, splitPeople, staffByName, supa, telegramActorFor, validateSplit };

