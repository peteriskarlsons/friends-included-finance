const { csv, isReady, loadLedger, resolveActor } = require('./lib');

module.exports = async (_req, res) => {
  if (!isReady()) return res.status(503).send('Shared ledger is not configured');
  try {
    const manager = await resolveActor('svetlana');
    const { sales } = await loadLedger(manager);
    const rows = [[
      'Reference', 'Date', 'Salesperson', 'Customer', 'Project', 'Description', 'Amount', 'Commission %', 'Commission EUR', 'Status',
      'Proposed Richard %', 'Proposed Anastasia %', 'Proposed Jean-Claude %', 'Final Richard %', 'Final Anastasia %', 'Final Jean-Claude %',
      'Richard earned EUR', 'Anastasia earned EUR', 'Jean-Claude earned EUR', 'Decision by', 'Decision at', 'Record type'
    ]];
    sales.forEach(sale => {
      const proposal = sale.proposed_split;
      const final = sale.final_split || {};
      const earned = sale.final_earnings || {};
      rows.push([
        sale.reference, String(sale.submitted_at || '').slice(0, 10) ? `${String(sale.submitted_at || '').slice(0, 10)} (UTC)` : '', sale.submitted_by_name, sale.customer, sale.project, sale.description,
        sale.amount, 0.1, sale.approved_commission || '', sale.status === 'approved' ? 'Approved' : 'Pending',
        proposal.richard, proposal.anastasia, proposal.jean, final.richard ?? '', final.anastasia ?? '', final.jean ?? '',
        earned.richard ?? '', earned.anastasia ?? '', earned.jean ?? '', sale.approved_by_name || '', String(sale.approved_at || '').slice(0, 19),
        sale.is_test_record ? 'Labelled test' : 'Original Test 2'
      ]);
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(csv(rows));
  } catch (error) { return res.status(500).send(error.message || 'Unable to export sales'); }
};

