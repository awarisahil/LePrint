import { supabaseAnon } from '../lib/supabase.js';

// Decodes a verified JWT's payload to read the custom `user_role` claim
// injected by the custom_access_token_hook. Only trustworthy AFTER
// supabaseAnon.auth.getUser() has validated the token.
function roleFromVerifiedToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.user_role || 'CUSTOMER';
  } catch {
    return 'CUSTOMER';
  }
}

// Requires a valid Supabase JWT in `Authorization: Bearer <token>`.
// Attaches req.user = { id, email, role } and req.accessToken.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }

  const { data, error } = await supabaseAnon.auth.getUser(token);

  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = {
    id: data.user.id,
    email: data.user.email,
    role: roleFromVerifiedToken(token),
  };
  req.accessToken = token;
  next();
}

// Optional guard for role-restricted routes: requireRole('ADMIN') etc.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}
