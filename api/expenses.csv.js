const { csv, isReady, loadLedger, resolveActor } = require('./lib');

module.exports = async (_req, res) => {
  if (!isReady()) return res.status(503).send('Shared ledger is not configured');
  try {
    const manager = await resolveActor('svetlana');
    const { expenses } = await loadLedger(manager);
    const rows = [[
      'Reference', 'Date', 'Submitted by', 'Project', 'Category', 'Description', 'Amount', 'Allocation status',
      'Proposed allocation', 'Final allocation', 'Decision by', 'Decision at', 'Record type'
    ]];
    expenses.forEach(expense => rows.push([
      expense.reference, String(expense.submitted_at || '').slice(0, 10) ? `${String(expense.submitted_at || '').slice(0, 10)} (UTC)` : '', expense.submitted_by_name,
      expense.project === 'overhead' ? 'Overhead' : expense.project === 'unallocated' ? 'Unallocated' : expense.project,
      expense.category, expense.description, expense.amount,
      expense.allocation_status === 'awaiting_allocation' ? 'Awaiting allocation' : expense.allocation_status === 'allocated' ? 'Allocated' : 'Recorded',
      expense.proposed_allocation || '', expense.project === 'unallocated' ? '' : expense.project, expense.allocated_by_name || '',
      String(expense.allocated_at || '').slice(0, 19), expense.is_test_record ? 'Labelled test' : 'Original Test 2'
    ]));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(csv(rows));
  } catch (error) { return res.status(500).send(error.message || 'Unable to export expenses'); }
};

