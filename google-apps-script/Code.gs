/**
 * Bound Google Apps Script for the Friends Included Finance spreadsheet.
 * Install once by running installExpenseSync from the Apps Script editor.
 * It uses no private keys: the CSV source is the publicly shared Vercel export.
 */
const EXPENSES_CSV_URL = 'https://friends-included-finance-sigma.vercel.app/api/expenses.csv';
const LIVE_EXPENSES_TAB = 'Live Expenses';
const EXPORT_COLUMNS = 13;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Finance sync')
    .addItem('Retry Live Expenses now', 'retryLiveExpenses')
    .addItem('Retry same expense reference…', 'retryExpenseReference')
    .addToUi();
}

function installExpenseSync() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.filter(trigger => trigger.getHandlerFunction() === 'scheduledExpenseSync').forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('scheduledExpenseSync').timeBased().everyMinutes(5).create();
  return syncLiveExpenses_();
}

function scheduledExpenseSync() {
  syncLiveExpenses_();
}

function retryLiveExpenses() {
  return syncLiveExpenses_();
}

function retryExpenseReference() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Retry existing test expense', 'Enter the same TEST-E reference. This refreshes the export only; it never creates another expense.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const reference = response.getResponseText().trim().toUpperCase();
  if (!/^TEST-E\d+$/.test(reference)) throw new Error('Enter an existing TEST-E reference.');
  const report = syncLiveExpenses_();
  const values = SpreadsheetApp.getActive().getSheetByName(LIVE_EXPENSES_TAB).getDataRange().getDisplayValues();
  if (!values.some(row => row[0] === reference)) throw new Error(`${reference} is not yet present in the shared export. ${report}`);
  SpreadsheetApp.getUi().alert(`${reference} refreshed without recreating it. ${report}`);
}

function syncLiveExpenses_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(LIVE_EXPENSES_TAB);
  if (!sheet) throw new Error(`Missing ${LIVE_EXPENSES_TAB} sheet.`);
  writeStatus_(sheet, 'Pending', 'Fetching the shared ledger…');
  try {
    const response = UrlFetchApp.fetch(`${EXPENSES_CSV_URL}?sync=${Date.now()}`, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error(`Source returned ${response.getResponseCode()}.`);
    const rows = Utilities.parseCsv(response.getContentText()).filter(row => row.some(value => value !== ''));
    if (!rows.length || rows[0][0] !== 'Reference') throw new Error('Source did not return the expected expense ledger.');
    const normalized = rows.map(row => Array.from({ length: EXPORT_COLUMNS }, (_, index) => row[index] || ''));
    sheet.getRange(1, 1, sheet.getMaxRows(), EXPORT_COLUMNS).clearContent();
    sheet.getRange(1, 1, normalized.length, EXPORT_COLUMNS).setValues(normalized);
    const labelled = normalized.slice(1).filter(row => row[12] === 'Labelled test');
    writeStatus_(sheet, 'Synced', `${normalized.length - 1} expenses • ${labelled.length} labelled test record${labelled.length === 1 ? '' : 's'}`);
    return `Synced ${normalized.length - 1} expenses.`;
  } catch (error) {
    writeStatus_(sheet, 'Failed', String(error.message || error).slice(0, 180));
    throw error;
  }
}

function writeStatus_(sheet, state, detail) {
  sheet.getRange('O1:P4').setValues([
    ['Expense sync status', 'Last attempt'],
    [state, new Date()],
    ['Detail', detail],
    ['Retry', 'Finance sync → Retry Live Expenses now']
  ]);
}

