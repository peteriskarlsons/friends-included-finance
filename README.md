# Friends Included Finance

Finance workflow for the fictional *Wedding Guests for Hire* assignment.

## Included

- Role-aware sales and expense entry workflow
- Manager approval for sales and project allocations
- Correct 10% commission handling and cent rounding in the browser demo
- Test 2 results: €5,300 approved income, €530 commission, €840 expenses, €3,930 company result
- Google Sheets finance workbook: https://docs.google.com/spreadsheets/d/1jJ1jH0tH7SW58GX9ThlU67rDJ3ghJEcRkDJN3MV0Hvg/edit
- Supabase database with RLS and server-only access
- Telegram webhook for @FriendsIncludedFinance29_bot

## Deploy configuration

Set these in Vercel before enabling the Telegram webhook:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (a long random secret)
- `GOOGLE_SHEET_URL`

Never commit any token or service key.

## Telegram commands

- `/dashboard`
- `/sale S06|A|Customer|1250|Description` (mapped sales staff)
- `/expense E08|Travel|140|Description` (mapped expenses staff)
- `/approve S05` (mapped manager)
