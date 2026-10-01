const api = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const actorNames = {
  richard: 'Richard',
  anastasia: 'Anastasia',
  jean: 'Jean-Claude',
  kevin: 'Kevin',
  svetlana: 'Svetlana'
};

const isReady = () => Boolean(api && key);
const headers = () => ({
  apikey: key,
  ...(key && key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
});

async function supa(path, options = {}) {
  if (!isReady()) throw new Error('Shared ledger is not configured');
  const response = await fetch(`${api}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Shared ledger request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

async function resolveActor(keyName) {
  const normalized = String(keyName || 'richard').toLowerCase();
  const name = actorNames[normalized];
  if (!name) throw new Error('Unknown fictional review account');
  const rows = await supa(`staff?select=id,name,role&name=eq.${encodeURIComponent(name)}&limit=1`);
  if (!rows[0]) throw new Error('Review account is unavailable');
  return { ...rows[0], key: normalized };
}

async function loadLedger(actor) {
  if (actor.role === 'manager') {
    const [staff, sales, expenses] = await Promise.all([
      supa('staff?select=id,name,role'),
      supa('sales?select=id,reference,submitted_by,customer,project,description,amount,proposed_commission,approved_commission,status,submitted_at,approved_at,approved_by&order=reference.asc'),
      supa('expenses?select=id,reference,submitted_by,description,category,amount,project,allocation_status,submitted_at,allocated_at,allocated_by&order=reference.asc')
    ]);
    const names = Object.fromEntries(staff.map(person => [person.id, person.name]));
    return {
      sales: sales.map(sale => ({ ...sale, submitted_by_name: names[sale.submitted_by] || 'Unknown' })),
      expenses: expenses.map(expense => ({ ...expense, submitted_by_name: names[expense.submitted_by] || 'Unknown' }))
    };
  }
  if (actor.role === 'sales') {
    const sales = await supa(`sales?select=id,reference,submitted_by,customer,project,description,amount,proposed_commission,approved_commission,status,submitted_at,approved_at&submitted_by=eq.${actor.id}&order=reference.asc`);
    return { sales: sales.map(sale => ({ ...sale, submitted_by_name: actor.name })), expenses: [] };
  }
  const expenses = await supa(`expenses?select=id,reference,submitted_by,description,category,amount,project,allocation_status,submitted_at,allocated_at&submitted_by=eq.${actor.id}&order=reference.asc`);
  return { sales: [], expenses: expenses.map(expense => ({ ...expense, submitted_by_name: actor.name })) };
}

function round(value) { return Math.round(Number(value || 0) * 100) / 100; }

function dashboardFor(actor, ledger) {
  const approved = ledger.sales.filter(sale => sale.status === 'approved');
  const pendingSales = ledger.sales.filter(sale => sale.status === 'pending');
  const awaitingExpenses = ledger.expenses.filter(expense => expense.allocation_status === 'awaiting_allocation');
  if (actor.role === 'manager') {
    const income = round(approved.reduce((total, sale) => total + Number(sale.amount), 0));
    const commission = round(approved.reduce((total, sale) => total + Number(sale.approved_commission), 0));
    const expenses = round(ledger.expenses.reduce((total, expense) => total + Number(expense.amount), 0));
    const project = name => {
      const projectSales = approved.filter(sale => sale.project === name);
      const saleIncome = round(projectSales.reduce((total, sale) => total + Number(sale.amount), 0));
      const saleCommission = round(projectSales.reduce((total, sale) => total + Number(sale.approved_commission), 0));
      const projectExpenses = round(ledger.expenses.filter(expense => expense.project === name).reduce((total, expense) => total + Number(expense.amount), 0));
      return { income: saleIncome, commission: saleCommission, expenses: projectExpenses, result: round(saleIncome - saleCommission - projectExpenses) };
    };
    return { visibility: 'manager', metrics: [
      { label: 'Approved income', value: income, detail: 'Approved sales only' },
      { label: 'Commission expense', value: commission, detail: '10% pool on approved sales' },
      { label: 'Recorded expenses', value: expenses, detail: 'Includes E07 while awaiting allocation' },
      { label: 'Company result', value: round(income - commission - expenses), detail: 'Shared-company view', kind: 'result' }
    ], projects: { A: project('A'), B: project('B') }, pendingSales, awaitingExpenses };
  }
  if (actor.role === 'sales') {
    const approvedIncome = round(approved.reduce((total, sale) => total + Number(sale.amount), 0));
    const pendingIncome = round(pendingSales.reduce((total, sale) => total + Number(sale.amount), 0));
    const approvedCommission = round(approved.reduce((total, sale) => total + Number(sale.approved_commission), 0));
    return { visibility: 'employee', metrics: [
      { label: 'Your approved sales', value: approvedIncome, detail: `${approved.length} approved record${approved.length === 1 ? '' : 's'}` },
      { label: 'Your pending sales', value: pendingIncome, detail: `${pendingSales.length} awaiting Svetlana` },
      { label: 'Approved commission pool', value: approvedCommission, detail: '10% of your approved sales' }
    ], projects: null, pendingSales, awaitingExpenses: [] };
  }
  const expenseTotal = round(ledger.expenses.reduce((total, expense) => total + Number(expense.amount), 0));
  const allocatedTotal = round(ledger.expenses.filter(expense => expense.allocation_status !== 'awaiting_allocation').reduce((total, expense) => total + Number(expense.amount), 0));
  const awaitingTotal = round(awaitingExpenses.reduce((total, expense) => total + Number(expense.amount), 0));
  return { visibility: 'employee', metrics: [
    { label: 'Your recorded expenses', value: expenseTotal, detail: `${ledger.expenses.length} submitted record${ledger.expenses.length === 1 ? '' : 's'}` },
    { label: 'Allocated or overhead', value: allocatedTotal, detail: 'Manager-confirmed or company overhead' },
    { label: 'Awaiting allocation', value: awaitingTotal, detail: `${awaitingExpenses.length} record${awaitingExpenses.length === 1 ? '' : 's'} awaiting Svetlana` }
  ], projects: null, pendingSales: [], awaitingExpenses };
}

function csvCell(value) { const text = value === null || value === undefined ? '' : String(value); return /[\",\n]/.test(text) ? `\"${text.replace(/\"/g, '\"\"')}\"` : text; }
function csv(rows) { return rows.map(row => row.map(csvCell).join(',')).join('\n'); }

module.exports = { actorNames, csv, dashboardFor, isReady, loadLedger, resolveActor, round, supa };

