import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, one } from './db.js';

export const SESSION_DAYS = 30;
export const COOKIE = 'metas_sid';

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

export const hashPassword = pw => bcrypt.hash(pw, 12);
export const checkPassword = (pw, hash) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (pw.length > 200) return 'A senha é longa demais.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letras e números na senha.';
  return null;
}

export async function createSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hashToken(token), userId, expires]);
  await q('UPDATE users SET last_login_at=now() WHERE id=$1', [userId]);
  return { token, expires };
}

export async function userFromSession(token) {
  if (!token) return null;
  return one(
    `SELECT u.id,u.email,u.name,u.cargo,u.role,u.team_id,u.active
       FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
    [hashToken(token)]
  );
}

export const destroySession = token => q('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);

/** Cria um link de uso único (convite: 7 dias; senha: 2 horas). Invalida links anteriores do mesmo tipo. */
export async function createLinkToken(userId, purpose) {
  const token = newToken();
  const hours = purpose === 'convite' ? 24 * 7 : 2;
  await q('DELETE FROM tokens WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL', [userId, purpose]);
  await q('INSERT INTO tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,$4)',
    [hashToken(token), userId, purpose, new Date(Date.now() + hours * 36e5)]);
  return token;
}

export async function useLinkToken(token) {
  const row = await one(
    `UPDATE tokens SET used_at=now()
      WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()
      RETURNING user_id,purpose`, [hashToken(token)]);
  return row;
}

export async function peekLinkToken(token) {
  return one(
    `SELECT t.purpose,u.name,u.email FROM tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at>now() AND u.active`, [hashToken(token)]);
}
