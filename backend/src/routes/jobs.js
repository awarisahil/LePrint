import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { generateDocument } from '../services/generator.js';

const router = Router();

const BUCKET = 'documents';
const FORMATS = ['PDF', 'DOCX', 'PNG', 'JPEG'];

// A Supabase client that acts as the CALLING USER (their JWT in the
// Authorization header), so inserts go through RLS policies and triggers
// (pricing trigger computes total_charged / vendor_cut server-side).
function clientAsUser(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function canSeeJob(user, job) {
  return user.role === 'ADMIN' || job.customer_id === user.id || job.vendor_id === user.id;
}

// Create a document job. CUSTOMER: for themselves (vendor_id NULL).
// VENDOR: on behalf of a customer (vendor_id = themselves).
// Money columns are computed by the DB — never accepted from the client.
router.post('/', requireAuth, async (req, res) => {
  const { template_id, requested_format, payload, customer_id } = req.body ?? {};

  if (!template_id || !requested_format || !payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'template_id, requested_format and payload are required' });
  }
  if (!FORMATS.includes(requested_format)) {
    return res.status(400).json({ error: `requested_format must be one of: ${FORMATS.join(', ')}` });
  }

  const insert = {
    template_id,
    requested_format,
    payload,
    customer_id:
      req.user.role === 'CUSTOMER'
        ? req.user.id
        : (customer_id ?? req.user.id), // VENDOR/ADMIN may specify the customer
    vendor_id: req.user.role === 'VENDOR' ? req.user.id : null,
  };

  const { data, error } = await clientAsUser(req.accessToken)
    .from('document_jobs')
    .insert(insert)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ job: data });
});

// Trigger generation for a job: mock generator -> storage -> COMPLETED.
// The DB trigger credits the vendor wallet the moment status = COMPLETED.
router.post('/:id/generate', requireAuth, async (req, res) => {
  const admin = getSupabaseAdmin();
  const { data: job, error } = await admin
    .from('document_jobs')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });
  if (!canSeeJob(req.user, job)) return res.status(403).json({ error: 'Not your document' });
  if (job.status === 'COMPLETED') return res.json({ job }); // idempotent
  if (!['PENDING', 'FAILED'].includes(job.status)) {
    return res.status(409).json({ error: `Job is ${job.status}` });
  }

  const { data: template } = await admin
    .from('templates')
    .select('*')
    .eq('id', job.template_id)
    .single();

  await admin.from('document_jobs').update({ status: 'PROCESSING', error_message: null }).eq('id', job.id);

  try {
    const file = await generateDocument({
      template,
      payload: job.payload,
      format: job.requested_format,
    });

    const path = `${job.id}/${job.requested_format.toLowerCase()}.${file.ext}`;
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.contentType, upsert: true });

    if (uploadError) {
      const hint = uploadError.message?.includes('Bucket not found')
        ? ` — create a PRIVATE bucket named "${BUCKET}" in Supabase Dashboard → Storage`
        : '';
      throw new Error(`Storage upload failed: ${uploadError.message}${hint}`);
    }

    const { data: updated, error: updateError } = await admin
      .from('document_jobs')
      .update({ status: 'COMPLETED', storage_path: path })
      .eq('id', job.id)
      .select()
      .single();

    if (updateError) throw new Error(updateError.message);
    res.json({ job: updated });
  } catch (err) {
    await admin
      .from('document_jobs')
      .update({ status: 'FAILED', error_message: err.message })
      .eq('id', job.id);
    res.status(500).json({ error: err.message });
  }
});

// Short-lived signed download URL. Only the customer, the generating vendor,
// or an admin can download.
router.get('/:id/download', requireAuth, async (req, res) => {
  const admin = getSupabaseAdmin();
  const { data: job, error } = await admin
    .from('document_jobs')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });
  if (!canSeeJob(req.user, job)) return res.status(403).json({ error: 'Not your document' });
  if (job.status !== 'COMPLETED' || !job.storage_path) {
    return res.status(409).json({ error: `Document not ready (status: ${job.status})` });
  }

  const filename = `${job.template_id}-${job.id}.${job.storage_path.split('.').pop()}`;
  const { data, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(job.storage_path, 3600, { download: filename });

  if (signError) return res.status(500).json({ error: signError.message });
  res.json({ url: data.signedUrl, expiresInSeconds: 3600, filename });
});

export default router;
