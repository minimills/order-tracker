# Belfast Mini Mills – Order Tracker

Project spec. Read this at the start of every session.

Belfast Mini Mills (Prince Edward Island, Canada) builds fibre-processing machines and ships them worldwide. Orders are currently tracked in a Google Sheet; this web app replaces it. The user is the office manager (not a developer).

## STACK
- Frontend: Vite + React + TypeScript + Tailwind CSS, React Router (HashRouter, because it will be hosted on GitHub Pages), date-fns, a toast library (sonner).
- Backend: Supabase (Postgres database, Auth, Row Level Security, Edge Functions).
- Scheduled jobs: GitHub Actions cron running Node scripts (added in later phases).
- AI: swappable provider. One shared module used everywhere, chosen by AI_PROVIDER = gemini (Google AI Studio free tier, the default to start), claude (Anthropic API, Claude Haiku) or ollama (local), and AI_MODEL. Only ever called server-side (Edge Functions or GitHub Actions), never from the browser.
- Email: our HostGator cPanel mailbox, IMAP (port 993, SSL) to read, SMTP (port 465, SSL) to send. Credentials only in Supabase secrets and GitHub Actions secrets.
- Timezone: America/Halifax. Currency per order: CAD or USD.

## CORE CONCEPTS
- An ORDER belongs to a CUSTOMER and has many MACHINES. Each machine has a machine type and a unique serial number.
- Order numbers are sequential (next after the highest). A split shipment uses suffixes: 76-1, 76-2.
- Serial numbers = machine type code + "-" + 4-digit number, counted per machine type (e.g. LCR-2072 then LCR-2073). Must be unique; generated atomically in the database.
- Order STAGES: Quote, Confirmed, In production, Ready to ship, Shipped, Cancelled.
- QUEUE POSITION ("board number"): this is our shop board, which tells the shop which order to build next. Orders in Confirmed / In production / Ready to ship have a board number 1..N. Moving an order up or down renumbers every other board number. When an order is Shipped or Cancelled it leaves the board and everyone behind it moves up. Serial numbers follow board order: per machine type, lower board numbers get lower serials. When the board changes, serials of machines not yet built are reassigned to keep that order; machines marked built keep their serial forever.
- Each order has: expected ship date, actual ship date (the day the shipment left), delay in days = actual - expected (negative = early), voltage (120V / 240V / Unknown), delivery equipment (Liftgate / No liftgate / Forklift / Tractor with forks / Unknown), freight type (LTL / FTL / LCL / 40' container / Other), free-text notes.
- PAYMENTS per order: order total, down payment (amount, due date, received date), balance (amount = total - down payment, due date, received date), plus optional extra payments. Show down payment as a % of total.
- ALERTS: payment due in 7 days, 3 days, today, overdue; expected ship date in 14 days / passed without an actual ship date; voltage Unknown on a confirmed order.
- Later phases: email sync, AI notes per order, an "ask the agent" chat, one-click reminder emails.

## ROLES, DROPDOWNS AND ARCHIVING (migration 0007 – follow these in every feature)
- ROLES: `allowed_users.role` is `admin` or `staff`. Staff can view, add and edit orders, customers, machines and payments (and archive them). Only admins can delete anything, change machine types, `option_lists` (dropdowns), `app_settings`, or manage `allowed_users`. RLS enforces this; the UI must also hide admin-only buttons using `useAuth().isAdmin`. There is always at least one admin (a trigger blocks removing the last one).
- DROPDOWNS: never hard-code choice lists in the code. Load them from `option_lists` (`list_name`, `value`, `sort_order`, `archived`, `locked`), ordered by `sort_order`. Lists: `voltage`, `delivery_equipment`, `freight_type`, `payment_type`. Columns `orders.voltage`, `orders.delivery_equipment`, `orders.freight_type` and `payments.payment_type` store the option's text; a trigger rejects values not in the list. Dropdowns offer only non-archived values, but still show an archived value already saved on a record. Renaming an option updates every record using it. `locked` options (voltage/delivery "Unknown", payment "Down payment"/"Balance") are built in and cannot be renamed, archived or deleted. New dropdowns = new `list_name` rows plus a validation trigger.
- ARCHIVING: `orders`, `customers`, `order_machines`, `machine_types` and `option_lists` have `archived`, `archived_at`, `archived_by` (filled automatically). The app archives instead of deleting; delete is admin-only and rare. Normal screens filter `archived = false`; offer a "Show archived" toggle where useful. An archived order leaves the board like a cancelled one; an archived unbuilt machine gives its serial back.

## RULES
- Clean, simple UI that works on a laptop and a phone. Plain words, no jargon.
- Never put secrets in frontend code or commit them. Use .env.local (gitignored) and a .env.example.
- Write SQL as numbered migration files in supabase/migrations.
- After each task, tell me exactly what to click or run to test it.

## Project layout (keep up to date)
- `src/` – React app. `src/lib/supabase.ts` is the only place the Supabase client is created.
- `src/components/` – shared UI (Layout with sidebar, AuthProvider, RequireAuth).
- `src/lib/auth.ts` – `useAuth()` hook: session, `allowed` (email is in allowed_users), `role`, `isAdmin`, signOut. Sign-in is Supabase email magic link with PKCE (needed because of HashRouter).
- `src/pages/` – one file per route. `NewOrderPage` (/orders/new), `OrderPage` (/orders/:id, read-only for now), `MachineTypesPage` (/settings/machine-types, admin edits), `OrdersBoardPage` (/board, Kanban), `ShopBoardPage` (/shop-board, printable, no sidebar), `OrdersListPage` (/orders, spreadsheet-style table + CSV; filters kept in the URL).
- `src/components/board/` – board parts: `OrderCard`, `MoveDialog` (preview + confirm every move), `badges.ts` (warning badges: voltage unknown, payment overdue/due soon, ship date close/passed).
- `src/components/form.tsx` – shared `Field`, `Section` and input/button classes. `src/components/order/` – New Order form parts (CustomerPicker, MachinesSection, serial preview).
- `src/lib/types.ts` (row types, fixed STAGES/CURRENCIES), `src/lib/format.ts` (`formatSerial`, `formatMoney`, `friendlyError`), `src/lib/useOptionList.ts` (load a dropdown from option_lists), `src/lib/fetchAll.ts` (load more than 1000 rows), `src/lib/dates.ts` (`todayISO()` in Halifax time), `src/lib/country.ts` (country name → flag), `src/lib/csv.ts`.
- `supabase/migrations/` – numbered SQL migrations (`0001_*.sql`, `0002_*.sql`, …). The user pastes them into the Supabase SQL Editor one at a time.
  - 0001 tables, 0002 machine type seed, 0003 serials + board (`next_serial`, `renumber_board`, `reassign_serials`, `move_board`, triggers), 0004 balance sync + `activity_log` triggers, 0005 `order_summary` view, 0006 RLS (`is_allowed_user()`), 0007 roles (`current_user_role()`, `is_admin()`), `option_lists`, `app_settings`, archiving, `payments.kind` renamed to `payment_type`, 0008 `create_order(p_order jsonb)` (saves customer + order + machines + payments in one transaction), `order_machines.serial_manual` (hand-typed serials, never reassigned), `next_serial` skips taken numbers, `machine_type_usage` view, 0009 `apply_board_change` / `preview_board_change` (stage + board place + optional mark built, returns serial changes; writes an activity_log `move` line), `order_summary` gains `payment_status`, `next_due_date`, `days_until_ship`, `machines_list`, `serials`.
  - Board numbers and serials are maintained by triggers; never set `board_position` or unbuilt serials directly from the app, call `apply_board_change` (always preview first with `preview_board_change` and show the serial changes) instead. New orders are saved only through the `create_order` RPC.
  - `order_machines.ready` = machine is built (keeps its serial forever).
- Only `VITE_`-prefixed env vars reach the browser; the Supabase anon key is the only key allowed there (RLS protects data). Service-role keys, AI keys and email passwords never go in `VITE_` vars.

## Commands
- `npm install` – install
- `npm run dev` – local dev server (http://localhost:5173)
- `npm run build` – type-check and production build
- `npm run lint` – linter (oxlint)
