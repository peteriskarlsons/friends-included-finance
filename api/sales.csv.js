const { csv, isReady, loadLedger, resolveActor } = require('./lib');
module.exports = async (_req, res) => {
  if (!isReady()) return res.status(503).send('Shared ledger is not configured');
  try {
    const manager = await resolveActor('svetlana'); const { sales } = await loadLedger(manager);
    const rows = [['Reference', 'Date', 'Salesperson', 'Customer', 'Project', 'Description', 'Amount', 'Commission %', 'Commission EUR', 'Status']];
    sales.forEach(sale => rows.push([sale.reference, String(sale.submitted_at || '').slice(0, 10), sale.submitted_by_name, sale.customer, sale.project, sale.description, sale.amount, 0.1, sale.approved_commission || '', sale.status === 'approved' ? 'Approved' : 'Pending']));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); return res.status(200).send(csv(rows));
  } catch (error) { return res.status(500).send(error.message || 'Unable to export sales'); }
};

