import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in backend/.env');
}

// Used to verify user JWTs (auth.getUser). Safe for that purpose: it cannot
// bypass RLS — only the service-role client below can.
export const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Used for privileged writes (job status updates, storage uploads, signed URLs).
// Lazily created so the server can start before the key is configured; any slice
// that needs it calls getSupabaseAdmin().
export function getSupabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set in backend/.env');
  }
  return createClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
