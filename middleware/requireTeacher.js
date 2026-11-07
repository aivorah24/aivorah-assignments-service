/**
 * Sign-in check for the private assignment library: the caller's Firebase ID
 * token (Authorization: Bearer <token>) decides who they are - never an email
 * or id in the request. Loads the users row by the token's email into
 * req.user; only teachers (and platform super admins) get through.
 *
 * Needs FIREBASE_SERVICE_ACCOUNT_B64 (same value as the other services).
 */
const firebaseAdmin = require('../services/firebaseAdmin');
const supabase = require('../services/supabase');

const ALLOWED_ROLES = ['teacher', 'super_admin'];

async function requireTeacher(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Sign in required' });
  if (!firebaseAdmin) return res.status(500).json({ error: 'Sign-in is not configured on this server' });

  let decoded;
  try {
    decoded = await firebaseAdmin.auth().verifyIdToken(match[1]);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired sign-in' });
  }
  if (!decoded.email) return res.status(401).json({ error: 'Sign-in has no email' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, role, email, name, school')
    .eq('email', decoded.email.toLowerCase())
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load your account' });
  if (!user) return res.status(403).json({ error: 'No Aivorah account for this sign-in' });
  if (!ALLOWED_ROLES.includes(user.role)) return res.status(403).json({ error: 'Only teachers have an assignment library' });

  req.user = user;
  next();
}

module.exports = { requireTeacher };
