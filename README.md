# Belfast Mini Mills – Order Tracker

A web app to track orders, the shop board, machines, serial numbers and payments for Belfast Mini Mills.
It replaces the old Google Sheet. The full project spec lives in [CLAUDE.md](CLAUDE.md).

Built with Vite + React + TypeScript + Tailwind CSS, with Supabase as the database.

## 1. What you need on your computer

- **Node.js 20 or newer** – download the "LTS" version from <https://nodejs.org> and install it.
- **Git** – <https://git-scm.com/downloads>.
- A free **Supabase** account – <https://supabase.com>.

To check Node is installed, open a terminal (Mac: *Terminal*; Windows: *PowerShell*) and run:

```bash
node -v
```

You should see something like `v22.x.x`.

## 2. Get the code and install

```bash
git clone https://github.com/minimills/order-tracker.git
```

```bash
cd order-tracker
```

```bash
npm install
```

## 3. Connect to Supabase

1. In Supabase, click **New project**. Name it `order-tracker`, choose the **Canada (Central)** region, set a database password and save it somewhere safe.
2. When the project is ready, open **Project Settings → API** (in newer versions: **Project Settings → Data API** for the URL and **API Keys** for the key).
3. In the project folder, make a copy of `.env.example` and name it `.env.local`:

   ```bash
   cp .env.example .env.local
   ```

4. Open `.env.local` in a text editor and paste in:
   - `VITE_SUPABASE_URL` – the **Project URL** (looks like `https://abcd1234.supabase.co`)
   - `VITE_SUPABASE_ANON_KEY` – the **anon / public** key

> **Never** put the `service_role` key, AI keys or email passwords in `.env.local` or anywhere in the frontend.
> Those go only in Supabase secrets and GitHub Actions secrets. `.env.local` is ignored by git, so it is never uploaded.

## 4. Run it

```bash
npm run dev
```

Open <http://localhost:5173> in your browser. You should see the sidebar with
Dashboard, Orders board, Orders list, Payments, Agent and Settings.

If a yellow bar saying "Not connected to the database yet" shows at the top, `.env.local` is missing or empty.
Fix it, then stop `npm run dev` (Ctrl+C) and start it again.

## Other commands

| Command | What it does |
| --- | --- |
| `npm run build` | Checks the code and builds the site into the `dist` folder |
| `npm run preview` | Shows the built site at <http://localhost:4173> |
| `npm run lint` | Checks the code for common mistakes |

## Project layout

```
src/
  App.tsx                page routes
  components/Layout.tsx  sidebar + page frame
  pages/                 one file per page
  lib/supabase.ts        the shared database connection
supabase/migrations/     database changes, as numbered SQL files
CLAUDE.md                project spec
```

## Notes

- The app uses `#` in its addresses (e.g. `/#/board`) so it works on GitHub Pages.
- Times are shown in Atlantic time (America/Halifax).
