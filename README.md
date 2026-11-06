# LePrint

A three-role document generation platform. Customers generate documents (PDF / DOCX /
PNG / JPEG); vendors generate documents **on behalf of** customers and earn a commission;
the admin runs the platform (pricing, vendors, payouts).

## Business model

- The customer pays a **fixed per-format price**, the same whether they generate
  directly or a vendor generates for them:
  | Format | Price (INR) |
  |---|---|
  | PDF | 10 |
  | PNG | 15 |
  | JPEG | 15 |
  | DOCX | 35 (premium format) |
- When a **vendor** generates the job, they earn a commission (default 20%, configurable
  per vendor as PERCENTAGE or FLAT). The commission is paid **from the platform's cut** —
  the customer is never charged extra.
- Vendor commissions accumulate in a **wallet**. Vendors request **payouts**; the admin
  approves / pays / rejects them. Rejection auto-refunds the held funds.
- Customer payments are **deferred** (mock mode: every job is recorded `PAID`).
  The `payment_status` column and backend structure are ready for Razorpay/Stripe later.

## Architecture

```
React app (Vite)  ──►  Node/Express API  ──►  Supabase (Postgres + RLS, Auth, Storage)
frontend/              backend/                 drbnuffyunttpmvwcyoq.supabase.co
                             │
                             ▼
                     Rust PDF service  ← PLANNED. A mock generator
                     (separate server)    currently produces real files;
                                          the module swaps for an HTTP call later.
```

Design rule: **the frontend writes *requests*; the database computes *money*.**
`total_charged`, `vendor_cut`, wallet balances and ledger entries are computed by
database triggers from `pricing_rules` / `vendor_profiles` — clients cannot tamper
with them. Job status updates and storage operations go through the backend
(service-role key) only.

### Repo layout

```
├── frontend/            # React 18 + Vite 5 + Tailwind 3 + react-router 6
│   └── src/
│       ├── context/AuthContext.jsx      # session + role from JWT user_role claim
│       ├── components/ProtectedRoute.jsx
│       ├── pages/AuthPage.jsx
│       └── pages/dashboard/             # Admin / Vendor / Customer placeholders
├── backend/             # Node 22 + Express 4
│   └── src/
│       ├── lib/supabase.js              # supabaseAnon, getSupabaseAdmin(), clientAsUser()
│       ├── middleware/auth.js           # requireAuth, requireRole
│       ├── services/generator.js        # MOCK generator (real PDF/DOCX/PNG/JPEG)
│       └── routes/                      # jobs, vendor, admin
└── supabase/migrations/
    ├── 0001_init.sql                    # schema + triggers + RLS + JWT hook
    ├── 0002_security_and_write_policies.sql
    └── 0003_seed_templates.sql          # 'invoice' template
```

## Database highlights

- **Tables**: `profiles` (1:1 with `auth.users`), `vendor_profiles` (commission config +
  wallet), `pricing_rules`, `templates`, `document_jobs`, `vendor_ledger`
  (append-only audit with `balance_after`), `vendor_payouts`.
- **Triggers**:
  - `handle_new_user` — creates `profiles` (+ `vendor_profiles` for vendors) on signup.
    Self-signup can only produce CUSTOMER/VENDOR; **ADMIN is granted manually via SQL**.
  - `compute_job_pricing` (BEFORE INSERT on jobs) — computes `total_charged` /
    `vendor_cut` from `pricing_rules` + the vendor's commission config, ignoring
    client-supplied values.
  - `on_job_status_change` (BEFORE UPDATE) — on `COMPLETED`, credits the vendor wallet +
    writes `COMMISSION_EARNED`; on COMPLETED→FAILED, reverses. Sets `completed_at`.
  - `hold_payout_funds` (BEFORE INSERT on payouts) — locks the vendor row, validates
    balance, holds funds atomically (no double-spend), writes ledger.
  - `process_payout_decision` — on REJECTED, refunds held funds + `PAYOUT_REFUNDED` entry.
- **RLS**: users read/write only their own data; the admin role (from the JWT
  `user_role` claim) sees all. `vendor_profiles` uses **column privileges**: a vendor
  can update only their `payout_info`.
- **JWT hook**: `custom_access_token_hook` injects `user_role` into every access token.
  Required grants: `USAGE ON SCHEMA public`, `EXECUTE` on the hook function, and
  `SELECT ON public.profiles` — all to `supabase_auth_admin` (the last one is easy to
  miss and fails every login with a 500 if omitted).

## Backend API

All endpoints except `/api/health` require `Authorization: Bearer <supabase-jwt>`.

| Method & path | Role | Purpose |
|---|---|---|
| `GET /api/health` | public | liveness check |
| `GET /api/me` | any | identity: `{ id, email, role }` from the verified JWT |
| `GET /api/admin-only-ping` | ADMIN | role-guard smoke test |
| `POST /api/jobs` | CUSTOMER / VENDOR | create job (as caller; DB computes price/commission). Vendor may pass `customer_id` |
| `POST /api/jobs/:id/generate` | owner, vendor, or admin | mock-generate file → Storage → `COMPLETED` (idempotent) |
| `GET /api/jobs/:id/download` | owner, vendor, or admin | 1-hour signed URL (ownership-checked) |
| `GET /api/vendor/overview` | VENDOR | wallet + commission + last 20 ledger entries + payouts |
| `POST /api/vendor/payouts` | VENDOR | request payout `{"amount": N}` (funds held by trigger) |
| `GET /api/vendor/payouts` | VENDOR | own payout history |
| `GET /api/admin/payouts?status=REQUESTED` | ADMIN | payout queue with vendor identity |
| `POST /api/admin/payouts/:id/decide` | ADMIN | `{"decision": "APPROVED" \| "PAID" \| "REJECTED", "admin_notes"}` |

Errors: `401` missing/invalid token · `403` wrong role · `404` missing row ·
`409` wrong state (e.g., decide a decided payout, download an unfinished job).

## Setup

### 1. Supabase project (once)

1. Run all migrations in `supabase/migrations/` in order (SQL Editor or `supabase db push`).
2. **Authentication → Hooks → "Customize access token"** → select `public.custom_access_token_hook`.
3. **Storage** → create a **private** bucket named exactly `documents`.
4. (Dev convenience) **Authentication → Sign In / Providers → Email** → turn OFF
   "Confirm email".
5. Create the first admin: sign up in the app, then:
   ```sql
   UPDATE profiles SET role = 'ADMIN' WHERE lower(email) = lower('you@example.com');
   ```
   Sign out and back in so a fresh token carries the role.

### 2. Frontend

```bash
cd frontend
cp .env.example .env       # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev                # http://localhost:5173
```

### 3. Backend

```bash
cd backend
cp .env.example .env       # fill SUPABASE_URL + SUPABASE_ANON_KEY (+ SUPABASE_SERVICE_ROLE_KEY
                           # for job generation / storage / admin endpoints)
npm install
npm run dev                # http://localhost:4000
```

**Never** put the service-role key in the frontend — it bypasses all RLS.

## Testing with Postman

**Log in (get a token):** `POST https://<project-ref>.supabase.co/auth/v1/token?grant_type=password`
with headers `apikey: <anon-key>`, `Content-Type: application/json`, body
`{"email": "...", "password": "..."}` → copy `access_token` from the response.
Tip: save it as a Postman collection variable (e.g. `{{token}}`) in the Authorization
tab of the backend requests. Tokens expire after ~1 hour — re-login when 401s appear.

**Core flows:**

1. **Customer, direct PDF** — `POST /api/jobs` with body
   `{"template_id": "invoice", "requested_format": "PDF", "payload": {...}}`
   → `201`, `total_charged: 10.00`, `vendor_cut: 0.00` (computed by the DB trigger).
   Then `POST /api/jobs/{id}/generate` → `COMPLETED`; `GET /api/jobs/{id}/download`
   → open `url` in a browser → real PDF.
2. **Vendor on behalf of customer (DOCX)** — vendor token, add
   `"customer_id": "<customer-uuid>"` → `total_charged: 35.00`, `vendor_cut: 7.00`.
   After generate: wallet + `COMMISSION_EARNED` row appear automatically.
3. **Payout loop** — vendor `POST /api/vendor/payouts {"amount": 5}` → funds held;
   overdraft returns 400 from the trigger. Admin `GET /api/admin/payouts?status=REQUESTED`
   → `POST /api/admin/payouts/{id}/decide {"decision": "REJECTED"}` → wallet refunded
   + `PAYOUT_REFUNDED` ledger entry; deciding twice → 409.
4. **Negative tests** — no token → 401; wrong-role token → 403; foreign job → 403;
   re-generate a COMPLETED job → returns unchanged; download before COMPLETED → 409.

Verify money directly in SQL Editor:
```sql
SELECT email, role FROM profiles;
SELECT wallet_balance, commission_rate FROM vendor_profiles;
SELECT entry_type, amount, balance_after FROM vendor_ledger ORDER BY created_at;
```

## Status & roadmap

**Done**
- [x] Database schema, RLS, triggers, JWT role hook (migrations 0001–0003)
- [x] Auth end-to-end: signup/login, role routing to `/admin` | `/vendor` | `/customer`
- [x] Backend: identity middleware, job pipeline (create → generate → download) with
      mock generator producing real PDF/DOCX/PNG/JPEG
- [x] Backend: vendor wallet/ledger/payouts + admin payout decisions
- [x] Frontend wiring: customer job form + downloads, vendor wallet/ledger/payout UI
      with generate-on-behalf-of-customer, admin payout queue (approve/pay/reject)
- [x] Postman test flows documented above

**Pending**
- [ ] Rust PDF service (replaces `services/generator.js` internals; same interface)
- [ ] Customer payment gateway (Razorpay/Stripe) — `payment_status` column ready
- [ ] Schema-driven payload forms (generate inputs from `templates.schema_definition`)
- [ ] Admin: pricing editor, vendor commission management, revenue stats
- [ ] Auth hardening: refresh-token rotation, rate limiting on the backend
