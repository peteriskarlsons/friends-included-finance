const { dashboardFor, isReady, loadLedger, resolveActor } = require('./lib');

module.exports = async (req, res) => {
  if (!isReady()) return res.status(503).json({ error: 'Shared ledger is not configured' });
  try {
    const actor = await resolveActor(req.query?.as);
    const ledger = await loadLedger(actor);
    const dashboard = dashboardFor(actor, ledger);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      actor: { key: actor.key, name: actor.name, role: actor.role },
      sales: ledger.sales,
      expenses: ledger.expenses,
      ...dashboard,
      googleSheet: process.env.GOOGLE_SHEET_URL || 'https://docs.google.com/spreadsheets/d/1jJ1jH0tH7SW58GX9ThlU67rDJ3ghJEcRkDJN3MV0Hvg/edit',
      testRoute: '/review.html'
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to load shared ledger' });
  }
};

