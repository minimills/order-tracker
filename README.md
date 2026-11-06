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
| `0013_import.sql` | "Needs serial" flag for imported machines |
| `0014_import_page.sql` | Import page: creates new orders and updates existing ones |
| `0015_change_order_machines.sql` | Add or remove machines on an existing order |
| `0016_departments.sql` | Departments, who belongs to which, department on every activity line |
| `0017_crating.sql` | Crates per machine (sizes, weight, plywood, hours), Imperial/Metric choice per person, crating report |
| `0018_permissions.sql` | Fine-grained permissions: each user sees only what an admin ticks (enforced by the database for money, contacts, edits, crating and Admin) |
| `0019_ready_stage_and_machine_chips.sql` | New stage “Ready” (built, being tested), renameable stage names, machine chips on the board, “final checklist done” per machine |
| `0020_final_checklists.sql` | Final checklist per machine: templates, item status (complete / not applicable), sign-off with signature (Storage), lock/unlock, no Ready to ship until signed |
| `0021_start_page_and_safe_notes.sql` | Start page per person; formatted notes are checked so no scripts can be saved |
| `0022_scheduling.sql` | Order defaults, scheduling settings, build times, department deadlines, “Crate?” per machine, department delays report; fixes staff creating orders |
| `0023_kanban_boards.sql` | Boards (personal now; production, parts and service later): stages, cards, labels, people, due dates, checklists, Start / Finish times, comments, history, sharing, groups, notifications bell, board templates |
| `0024_user_logins.sql` | Admin → Users makes real logins (with the `admin-users` Edge Function, see below); sign-in page checks access first |
| `0025_wording.sql` | Professional wording for two final check messages (no change in behaviour) |

Then let yourself in (change the email to yours), in a new SQL Editor query:

```sql
insert into public.allowed_users (email, name) values ('you@example.com', 'Your name');
```

After the first admin exists, add and manage people in the app under **Admin → Users** instead.

New users are **users** and see **nothing** until an admin ticks what they need in **Admin → Users → Permissions**
(start from a department preset, a template, or another person). Admins see and do everything. To make someone an admin:

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

Sign-in uses a 6-digit code sent by email. In Supabase → **Authentication → Emails → Magic Link**, the email must show the code: put `{{ .Token }}` in the message.
Recommended wording (paste it there and click **Save**):

- **Subject:** `Your Belfast Mini Mills sign-in code`
- **Message body:**

  ```html
  <p>Hello,</p>
  <p>Your sign-in code for the Belfast Mini Mills Order Tracker is:</p>
  <p style="font-size:24px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
  <p>Enter this code on the sign-in page at https://order.minimills.net. The code can be used once and expires after a short time.</p>
  <p>If you did not request this code, you can ignore this email.</p>
  <p>Belfast Mini Mills</p>
  ```
Supabase's built-in email sender only allows a few emails per hour; that is fine for a small team.

### The `admin-users` Edge Function (makes logins)

Sign-ups stay **off** in Supabase (Authentication → Sign In / Providers → "Allow new users to sign up" unticked).
Admin → Users makes each person's login through this function. It needs no extra secret: Supabase gives every Edge
Function its own service role key automatically.

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `admin-users`.
3. Replace the example code with all of `supabase/functions/admin-users/index.ts`, then click **Deploy function**.
4. Leave **Verify JWT** (JWT verification) switched on.

To update it later, open the function, paste the new code and deploy again.

## 5. Run it

```bash
npm run dev
```

Open <http://localhost:5173> in your browser. You will see the sign-in page. Enter your email, type the 6-digit code from the
email, and you should see the sidebar with Dashboard, Orders board, Orders list, Payments, Agent and Settings.

If a yellow bar saying "Not connected to the database yet" shows at the top, `.env.local` is missing or empty.
Fix it, then stop `npm run dev` (Ctrl+C) and start it again.

## Importing the old Google Sheet

Everything happens in the browser: **Admin → Import & backup**. Download the template, paste your rows in, upload it,
check the preview (fix or untick red rows), then press **Import**. **Download all data** there makes a backup in the same
layout. Never commit spreadsheets with customer data to GitHub (`.xlsx` files are ignored by git).

## Going live (GitHub Pages at https://order.minimills.net)

Every push to `main` builds the app and publishes it (`.github/workflows/deploy.yml`).
One-time setup:

1. GitHub → repo → **Settings → Secrets and variables → Actions → Variables** → add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (same values as in `.env.local`).
2. GitHub → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. cPanel → **Zone Editor** → minimills.net → **+ Add Record**: type **CNAME**, name `order`, record
   `minimills.github.io`.
4. GitHub → **Settings → Pages → Custom domain**: `order.minimills.net` → Save. When the DNS check is green and the
   certificate is ready, tick **Enforce HTTPS**.
5. Supabase → **Authentication → URL Configuration**: Site URL `https://order.minimills.net`, and add
   `https://order.minimills.net/**` to the Redirect URLs (keep `http://localhost:5173/**` for testing on your computer).

## Other commands

| Command | What it does |
| --- | --- |
| `npm run build` | Checks the code and builds the site into the `dist` folder |
| `npm run preview` | Shows the built site at <http://localhost:4173> |
| `npm run lint` | Checks the code for common mistakes |
| `npm run check:perms` | Checks every screen element has a permission (runs by itself before each commit) |

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

- The app uses `#` in its addresses (e.g. `/#/board`) so it works on GitHub Pages. It is published at https://order.minimills.net.
- Times are shown in Atlantic time (America/Halifax).
