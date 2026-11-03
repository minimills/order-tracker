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

## 4. Set up the database

Run each file in `supabase/migrations/` **in number order**, one at a time:

1. In Supabase, open **SQL Editor** (left menu) and click **New query** (or **+**).
2. Open the migration file, copy all of it, paste it in, and click **Run**.
3. You should see **Success. No rows returned**. Then do the next file.

| File | What it does |
| --- | --- |
| `0001_tables.sql` | Creates the tables (customers, machine types, orders, machines, payments, activity log, allowed users) |
| `0002_seed_machine_types.sql` | Adds the 31 machine types |
| `0003_serials_and_board.sql` | Serial numbers and the shop board (`next_serial`, `move_board`) |
| `0004_payments_and_activity_log.sql` | Balance = total − down payment; records every change |
| `0005_order_summary_view.sql` | The `order_summary` view (delay, machines ready, paid, outstanding) |
| `0006_security.sql` | Only signed-in, allowed users can see or change anything |
| `0007_roles_options_archiving.sql` | Admin/staff roles, editable dropdown lists, archive instead of delete |
| `0008_create_order.sql` | Saves a new order in one step; hand-typed serials |
| `0009_board_moves.sql` | Orders board moves (with a preview of serial changes); payment status for badges |
| `0010_payments_received.sql` | Received amounts (part payments), payment status per payment, "Mark received" |
| `0011_alerts.sql` | Alerts (payments due/overdue, ship dates, unknown voltage), per-user snooze/dismiss, alert settings |
| `0012_admin.sql` | Admin area: admin-only rules and tools (serials, board, permanent delete), company details |
| `0013_import.sql` | Importing the old Google Sheet; "needs serial" flag |

Then let yourself in (change the email to yours), in a new SQL Editor query:

```sql
insert into public.allowed_users (email, name) values ('you@example.com', 'Your name');
```

After the first admin exists, add and manage people in the app under **Admin → Users** instead.

New users are **staff** (can add and edit). Admins can also delete, change machine types, dropdown lists,
settings and users. To make someone an admin:

```sql
update public.allowed_users set role = 'admin' where email = 'them@example.com';
```

To remove someone later: `delete from public.allowed_users where email = 'them@example.com';`

**Before entering real orders**, set each machine type's next serial number: **Table Editor → machine_types**,
change `next_serial_number` (e.g. `2073` if the last Large Carder was LCR-2072). Types with an empty `code`
get no serial numbers until you fill in a code.

### Sign-in settings

In Supabase, open **Authentication → URL Configuration**:

- **Site URL**: `http://localhost:5173`
- **Redirect URLs**: add `http://localhost:5173/**` (and later the GitHub Pages address, e.g. `https://minimills.github.io/order-tracker/**`)

Sign-in links must be opened in the same browser where you asked for them.
Supabase's built-in email sender only allows a few emails per hour; that is fine for a small team.

## 5. Run it

```bash
npm run dev
```

Open <http://localhost:5173> in your browser. You will see the sign-in page. Enter your email, click the link in the
email, and you should see the sidebar with Dashboard, Orders board, Orders list, Payments, Agent and Settings.

If a yellow bar saying "Not connected to the database yet" shows at the top, `.env.local` is missing or empty.
Fix it, then stop `npm run dev` (Ctrl+C) and start it again.

## Importing the old Google Sheet

1. In Google Sheets: **File → Download → Microsoft Excel (.xlsx)**. Put the file in the `import` folder of the project
   (that folder is never uploaded to GitHub).
2. Dry run (saves nothing):

   ```bash
   npm run import-sheet
   ```

   Read the report (also saved as `import/last-dry-run.txt`). Fix any "problems that stop the import" in the sheet, export
   again and repeat.
3. Add the secret key to `.env.local` (Supabase → Project Settings → API Keys → `service_role`):
   `SUPABASE_SERVICE_ROLE_KEY=...` (no `VITE_` in front).
4. Import for real:

   ```bash
   npm run import-sheet -- --commit
   ```

5. Delete the `SUPABASE_SERVICE_ROLE_KEY` line from `.env.local` again.

Options: `--usd-countries "USA,United States"` (those orders in USD; default all CAD), `--keep-serials` (keep every
serial exactly as in the sheet instead of following board order), `--sheet 2025`, `--file import/other.xlsx`.

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
  components/AuthProvider.tsx, RequireAuth.tsx   sign-in handling
  pages/                 one file per page (LoginPage.tsx = sign-in)
  lib/supabase.ts        the shared database connection
  lib/auth.ts            useAuth(): who is signed in
supabase/migrations/     database changes, as numbered SQL files
CLAUDE.md                project spec
```

## Notes

- The app uses `#` in its addresses (e.g. `/#/board`) so it works on GitHub Pages.
- Times are shown in Atlantic time (America/Halifax).
