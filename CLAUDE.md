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

## RULES
- Clean, simple UI that works on a laptop and a phone. Plain words, no jargon.
- Never put secrets in frontend code or commit them. Use .env.local (gitignored) and a .env.example.
- Write SQL as numbered migration files in supabase/migrations.
- After each task, tell me exactly what to click or run to test it.

## Project layout (keep up to date)
- `src/` – React app. `src/lib/supabase.ts` is the only place the Supabase client is created.
- `src/components/` – shared UI (Layout with sidebar).
- `src/pages/` – one file per route.
- `supabase/migrations/` – numbered SQL migrations (`0001_*.sql`, `0002_*.sql`, …).
- Only `VITE_`-prefixed env vars reach the browser; the Supabase anon key is the only key allowed there (RLS protects data). Service-role keys, AI keys and email passwords never go in `VITE_` vars.

## Commands
- `npm install` – install
- `npm run dev` – local dev server (http://localhost:5173)
- `npm run build` – type-check and production build
- `npm run lint` – ESLint
