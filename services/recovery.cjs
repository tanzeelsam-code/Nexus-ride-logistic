'use strict';
const crypto = require('node:crypto');
const { z } = require('zod');

const email = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const password = z.string().min(12).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes');
const digest = code => crypto.createHash('sha256').update(code).digest('hex');

function registerRecovery({ app, query, transaction, bcrypt, validate, requireDatabase, dummyHash, onRecovered }) {
  const options = { preHandler: requireDatabase, config: { rateLimit: { max: 5, timeWindow: 900000 } } };

  // Re-authenticate before replacing the offline recovery credential. Store only its hash.
  app.post('/api/v1/auth/recovery-code', options, async (req, reply) => {
    const body = validate(z.object({ email, password: z.string().min(1).max(72) }), req.body);
    const { rows: [user] } = await query('SELECT id,password_hash,is_active,is_banned FROM users WHERE email=$1', [body.email]);
    const valid = await bcrypt.compare(body.password, user?.password_hash || dummyHash);
    if (!valid || !user?.is_active || user.is_banned) return reply.code(401).send({ error: 'Invalid email or password' });
    const code = crypto.randomBytes(32).toString('base64url');
    const updated = await query(`UPDATE users SET recovery_code_hash=$1
      WHERE id=$2 AND password_hash=$3 AND is_active AND NOT is_banned RETURNING id`, [digest(code), user.id, user.password_hash]);
    if (!updated.rowCount) return reply.code(409).send({ error: 'Your account changed. Please sign in again.' });
    return { recovery_code: code, message: 'Save this code privately. It replaces your previous code and can be used once.' };
  });

  app.post('/api/v1/auth/recover', options, async (req, reply) => {
    const body = validate(z.object({ email, recovery_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), new_password: password }), req.body);
    const codeHash = digest(body.recovery_code);
    const { rows: [candidate] } = await query(`SELECT id FROM users
      WHERE email=$1 AND recovery_code_hash=$2 AND is_active AND NOT is_banned`, [body.email, codeHash]);
    if (!candidate) return reply.code(400).send({ error: 'Invalid or already used recovery code' });
    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(body.new_password, salt);
    const user = await transaction(async client => {
      // Conditional UPDATE consumes the code exactly once, including concurrent attempts.
      const { rows: [updated] } = await client.query(`UPDATE users SET password_hash=$1,salt=$2,
        recovery_code_hash=NULL,auth_version=auth_version+1,password_changed_at=NOW()
        WHERE id=$3 AND recovery_code_hash=$4 AND is_active AND NOT is_banned RETURNING id`, [hash, salt, candidate.id, codeHash]);
      if (updated) await client.query('DELETE FROM push_subscriptions WHERE user_id=$1', [updated.id]);
      return updated;
    });
    if (!user) return reply.code(400).send({ error: 'Invalid or already used recovery code' });
    await onRecovered(user.id);
    return { message: 'Password changed. Your previous sessions and recovery code have been revoked. Sign in and save a new recovery code.' };
  });
}

module.exports = { registerRecovery };
