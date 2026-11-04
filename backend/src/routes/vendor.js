import { Router } from 'express';
import { clientAsUser } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Everything here is VENDOR-only (admins use /api/admin/*).
router.use(requireAuth, requireRole('VENDOR'));

// Single dashboard payload: wallet + recent ledger + recent payouts.
// Reads run as the caller, so RLS scopes everything to this vendor.
router.get('/overview', async (req, res) => {
  const db = clientAsUser(req.accessToken);
  const [profileRes, ledgerRes, payoutsRes] = await Promise.all([
    db
      .from('vendor_profiles')
      .select('business_name, wallet_balance, payout_info, commission_type, commission_rate')
      .eq('user_id', req.user.id)
      .single(),
    db.from('vendor_ledger').select('*').order('created_at', { ascending: false }).limit(20),
    db.from('vendor_payouts').select('*').order('created_at', { ascending: false }).limit(20),
  ]);

  if (profileRes.error) return res.status(400).json({ error: profileRes.error.message });
  res.json({
    profile: profileRes.data,
    ledger: ledgerRes.data ?? [],
    payouts: payoutsRes.data ?? [],
  });
});

// Request a payout. The DB trigger (hold_payout_funds) checks the balance,
// locks the row, holds the funds, and writes the ledger entry atomically —
// so a vendor can never overdraw, even with concurrent requests.
router.post('/payouts', async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  const rounded = Math.round(amount * 100) / 100;

  const { data, error } = await clientAsUser(req.accessToken)
    .from('vendor_payouts')
    .insert({ vendor_id: req.user.id, amount: rounded })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ payout: data });
});

router.get('/payouts', async (req, res) => {
  const { data, error } = await clientAsUser(req.accessToken)
    .from('vendor_payouts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ payouts: data });
});

export default router;
