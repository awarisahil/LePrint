import { Router } from 'express';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Everything here is ADMIN-only.
router.use(requireAuth, requireRole('ADMIN'));

const DECISIONS = ['APPROVED', 'PAID', 'REJECTED'];

// Pending + recent payouts, with vendor identity attached.
// ?status=REQUESTED narrows the list.
router.get('/payouts', async (req, res) => {
  let query = getSupabaseAdmin()
    .from('vendor_payouts')
    .select('*, vendor:profiles!vendor_payouts_vendor_id_fkey(email, full_name)')
    .order('created_at', { ascending: false })
    .limit(100);

  const status = String(req.query.status ?? '').toUpperCase();
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ payouts: data });
});

// Approve, mark-paid, or reject a payout request.
// REJECTED is safe by construction: the process_payout_decision trigger
// refunds the held funds and writes a PAYOUT_REFUNDED ledger entry.
router.post('/payouts/:id/decide', async (req, res) => {
  const { decision, admin_notes } = req.body ?? {};
  if (!DECISIONS.includes(decision)) {
    return res.status(400).json({ error: `decision must be one of: ${DECISIONS.join(', ')}` });
  }

  const admin = getSupabaseAdmin();

  const { data: existing, error: fetchError } = await admin
    .from('vendor_payouts')
    .select('id, status')
    .eq('id', req.params.id)
    .single();
  if (fetchError || !existing) return res.status(404).json({ error: 'Payout not found' });
  if (existing.status !== 'REQUESTED') {
    return res.status(409).json({ error: `Payout already ${existing.status}` });
  }

  const { data, error } = await admin
    .from('vendor_payouts')
    .update({
      status: decision,
      admin_notes: admin_notes ?? null,
      processed_by: req.user.id,
      processed_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .eq('status', 'REQUESTED') // optimistic guard against concurrent decisions
    .select()
    .single();

  if (error || !data) {
    return res.status(409).json({ error: 'Payout was just decided by someone else — refresh' });
  }
  res.json({ payout: data });
});

export default router;
