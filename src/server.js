import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, migrate } from './db.js';
import {
  COOKIE, SESSION_DAYS, createSession, userFromSession, destroySession, hashPassword, checkPassword,
  passwordProblem, createLinkToken, useLinkToken, peekLinkToken,
} from './auth.js';
import { canView, visiblePeople, visibleTeams } from './access.js';
import { mailEnabled, sendLink } from './mail.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads');
const COOKIE_SECURE = String(process.env.COOKIE_SECURE ?? 'true').toLowerCase() !== 'false';
const PORT = Number(process.env.PORT || 3000);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 4 * 1024 * 1024, trustProxy: true });

await app.register(cookie);
await app.register(rateLimit, { global: false });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
await app.register(fstatic, { root: path.join(ROOT, 'public'), index: false });
await app.register(fstatic, {
  root: path.join(ROOT, 'node_modules', 'pptxgenjs', 'dist'), prefix: '/vendor/', decorateReply: false,
  allowedPath: p => p === '/pptxgen.bundle.js',
});

// ---------- utilidades ----------
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const DOC_ID = /^[A-Za-z0-9_.:@+~-]{1,200}$/;
const COLLS = new Set(['goals', 'boards', 'settings']);
const ROLES = new Set(['colaborador', 'supervisor', 'admin']);
const cleanEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const baseUrl = req => (process.env.BASE_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');

function setSessionCookie(reply, token) {
  reply.setCookie(COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: SESSION_DAYS * 86400,
  });
}

// Cabeçalhos de segurança em todas as respostas.
app.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  return payload;
});

// Proteção contra CSRF: toda requisição que altera dados precisa do cabeçalho X-Requested-With.
app.addHook('onRequest', async (req) => {
  if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.headers['x-requested-with'] !== 'metas') throw httpError(403, 'Requisição recusada.');
  }
  const token = req.cookies?.[COOKIE];
  req.user = token ? await userFromSession(token) : null;
});

const auth = async (req) => { if (!req.user) throw httpError(401, 'Faça login para continuar.'); };
const admin = async (req) => {
  await auth(req);
  if (req.user.role !== 'admin') throw httpError(403, 'Apenas administradores podem fazer isso.');
};

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode || 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: code >= 500 ? 'Erro interno. Tente de novo em instantes.' : err.message });
});

// ---------- páginas ----------
const page = name => (req, reply) => reply.type('text/html; charset=utf-8').sendFile(name);
app.get('/', (req, reply) => (req.user ? page('app.html')(req, reply) : reply.redirect('/entrar')));
app.get('/entrar', (req, reply) => (req.user ? reply.redirect('/') : page('login.html')(req, reply)));
app.get('/definir-senha', page('senha.html'));
app.get('/saude', async () => ({ ok: true }));

// ---------- autenticação ----------
const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } };

app.post('/api/auth/login', loginLimit, async (req, reply) => {
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const u = await one('SELECT id,password_hash,active FROM users WHERE email=$1', [email]);
  const ok = u && u.active && (await checkPassword(password, u.password_hash));
  if (!ok) throw httpError(401, 'E-mail ou senha incorretos.');
  const { token } = await createSession(u.id);
  setSessionCookie(reply, token);
  return { ok: true };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies?.[COOKIE];
  if (token) await destroySession(token);
  reply.clearCookie(COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/auth/link', async (req) => {
  const info = await peekLinkToken(String(req.query.token || ''));
  if (!info) throw httpError(404, 'Este link expirou ou já foi usado. Peça um novo ao administrador.');
  return info;
});

app.post('/api/auth/definir-senha', loginLimit, async (req, reply) => {
  const problem = passwordProblem(req.body?.password);
  if (problem) throw httpError(400, problem);
  const row = await useLinkToken(String(req.body?.token || ''));
  if (!row) throw httpError(400, 'Este link expirou ou já foi usado. Peça um novo ao administrador.');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(req.body.password), row.user_id]);
  await q('DELETE FROM sessions WHERE user_id=$1', [row.user_id]);
  const { token } = await createSession(row.user_id);
  setSessionCookie(reply, token);
  return { ok: true };
});

app.post('/api/auth/esqueci', loginLimit, async (req) => {
  if (!mailEnabled()) return { ok: true, email: false };
  const u = await one('SELECT id,name,email FROM users WHERE email=$1 AND active', [cleanEmail(req.body?.email)]);
  if (u) {
    const token = await createLinkToken(u.id, 'senha');
    await sendLink({ to: u.email, name: u.name, link: `${baseUrl(req)}/definir-senha?token=${token}`, purpose: 'senha' })
      .catch(e => req.log.error(e));
  }
  return { ok: true, email: true };
});

app.get('/api/config', async () => ({ email: mailEnabled() }));

// ---------- conta ----------
app.get('/api/me', { preHandler: auth }, async (req) => {
  const team = req.user.team_id ? await one('SELECT id,name FROM teams WHERE id=$1', [req.user.team_id]) : null;
  const supervises = (await q('SELECT id,name FROM teams WHERE supervisor_id=$1 ORDER BY name', [req.user.id])).rows;
  return { ...req.user, team, supervises };
});

app.post('/api/me/senha', { preHandler: auth }, async (req, reply) => {
  const u = await one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await checkPassword(String(req.body?.current || ''), u.password_hash))) throw httpError(400, 'A senha atual está incorreta.');
  const problem = passwordProblem(req.body?.password);
  if (problem) throw httpError(400, problem);
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(req.body.password), req.user.id]);
  await q('DELETE FROM sessions WHERE user_id=$1', [req.user.id]);
  const { token } = await createSession(req.user.id);
  setSessionCookie(reply, token);
  return { ok: true };
});

// ---------- dados de metas ----------
async function ownerFor(req, ownerParam) {
  const ownerId = ownerParam || req.user.id;
  if (!isUuid(ownerId)) throw httpError(400, 'Pessoa inválida.');
  if (!(await canView(req.user, ownerId))) throw httpError(403, 'Você não tem acesso às metas desta pessoa.');
  return ownerId;
}

app.get('/api/estado', { preHandler: auth }, async (req) => {
  const ownerId = await ownerFor(req, req.query.pessoa);
  const owner = await one(
    'SELECT u.id,u.name,u.cargo,u.email,t.name AS team_name FROM users u LEFT JOIN teams t ON t.id=u.team_id WHERE u.id=$1', [ownerId]);
  const rows = (await q('SELECT coll,doc_id,data,updated_at FROM docs WHERE owner_id=$1', [ownerId])).rows;
  const out = { goals: [], boards: [], settings: {} };
  let last = null;
  for (const r of rows) {
    if (!last || r.updated_at > last) last = r.updated_at;
    if (r.coll === 'settings') out.settings[r.doc_id] = r.data;
    else out[r.coll].push({ ...r.data, id: r.doc_id });
  }
  return { owner, readonly: ownerId !== req.user.id, updatedAt: last, ...out };
});

function checkDoc(req) {
  const { coll, id } = req.params;
  if (!COLLS.has(coll) || !DOC_ID.test(id)) throw httpError(400, 'Documento inválido.');
  const data = req.body?.data;
  if (req.method !== 'DELETE' && (!data || typeof data !== 'object' || Array.isArray(data))) throw httpError(400, 'Dados inválidos.');
  return { coll, id, data };
}

// Somente o dono edita os próprios dados.
app.put('/api/docs/:coll/:id', { preHandler: auth }, async (req) => {
  const { coll, id, data } = checkDoc(req);
  await q(`INSERT INTO docs(owner_id,coll,doc_id,data) VALUES($1,$2,$3,$4)
           ON CONFLICT (owner_id,coll,doc_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
    [req.user.id, coll, id, data]);
  return { ok: true };
});

app.patch('/api/docs/:coll/:id', { preHandler: auth }, async (req) => {
  const { coll, id, data } = checkDoc(req);
  // Mescla os campos enviados no documento (cria o documento se ainda não existir).
  await q(`INSERT INTO docs(owner_id,coll,doc_id,data) VALUES($1,$2,$3,$4::jsonb)
           ON CONFLICT (owner_id,coll,doc_id) DO UPDATE SET data=docs.data||EXCLUDED.data, updated_at=now()`,
    [req.user.id, coll, id, data]);
  return { ok: true };
});

app.delete('/api/docs/:coll/:id', { preHandler: auth }, async (req) => {
  const { coll, id } = checkDoc(req);
  await q('DELETE FROM docs WHERE owner_id=$1 AND coll=$2 AND doc_id=$3', [req.user.id, coll, id]);
  return { ok: true };
});

// ---------- fotos ----------
function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
  return null;
}

app.post('/api/fotos', { preHandler: auth }, async (req) => {
  const file = await req.file();
  if (!file) throw httpError(400, 'Nenhum arquivo enviado.');
  const buf = await file.toBuffer();
  const mime = sniffImage(buf);
  if (!mime) throw httpError(400, 'Envie uma imagem JPG, PNG, WEBP ou GIF.');
  const row = await one('INSERT INTO photos(owner_id,mime,size) VALUES($1,$2,$3) RETURNING id', [req.user.id, mime, buf.length]);
  fs.writeFileSync(path.join(UPLOAD_DIR, row.id), buf);
  return { id: row.id, url: `/api/fotos/${row.id}` };
});

app.get('/api/fotos/:id', { preHandler: auth }, async (req, reply) => {
  if (!isUuid(req.params.id)) throw httpError(404, 'Foto não encontrada.');
  const p = await one('SELECT id,owner_id,mime FROM photos WHERE id=$1', [req.params.id]);
  if (!p || !(await canView(req.user, p.owner_id))) throw httpError(404, 'Foto não encontrada.');
  const file = path.join(UPLOAD_DIR, p.id);
  if (!fs.existsSync(file)) throw httpError(404, 'Foto não encontrada.');
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  return reply.type(p.mime).send(fs.createReadStream(file));
});

app.delete('/api/fotos/:id', { preHandler: auth }, async (req) => {
  if (!isUuid(req.params.id)) throw httpError(404, 'Foto não encontrada.');
  const p = await one('DELETE FROM photos WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (p) fs.rmSync(path.join(UPLOAD_DIR, p.id), { force: true });
  return { deleted: !!p };
});

// ---------- times e pessoas (leitura para supervisor/admin) ----------
app.get('/api/pessoas', { preHandler: auth }, async (req) => ({ pessoas: await visiblePeople(req.user) }));
app.get('/api/times', { preHandler: auth }, async (req) => ({ times: await visibleTeams(req.user) }));

// ---------- administração ----------
async function activeAdmins(exceptId) {
  return (await one(`SELECT count(*)::int AS n FROM users WHERE role='admin' AND active AND id<>$1`, [exceptId])).n;
}

async function issueLink(req, user, purpose) {
  const token = await createLinkToken(user.id, purpose);
  const link = `${baseUrl(req)}/definir-senha?token=${token}`;
  let emailed = false;
  try { emailed = await sendLink({ to: user.email, name: user.name, link, purpose }); }
  catch (e) { req.log.error(e); }
  return { link, emailed };
}

app.get('/api/admin/usuarios', { preHandler: admin }, async () => {
  const rows = (await q(`SELECT u.id,u.email,u.name,u.cargo,u.role,u.team_id,t.name AS team_name,u.active,
                                u.last_login_at,(u.password_hash IS NOT NULL) AS has_password
                           FROM users u LEFT JOIN teams t ON t.id=u.team_id ORDER BY u.name`)).rows;
  return { usuarios: rows };
});

function readUserBody(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = String(b.name || '').trim();
    if (!out.name || out.name.length > 120) throw httpError(400, 'Informe o nome (até 120 caracteres).');
  }
  if (!partial || b.email !== undefined) {
    out.email = cleanEmail(b.email);
    if (!validEmail(out.email)) throw httpError(400, 'Informe um e-mail válido.');
  }
  if (b.cargo !== undefined) out.cargo = String(b.cargo || '').trim().slice(0, 120);
  if (!partial || b.role !== undefined) {
    out.role = b.role || 'colaborador';
    if (!ROLES.has(out.role)) throw httpError(400, 'Perfil inválido.');
  }
  if (b.team_id !== undefined) {
    out.team_id = b.team_id || null;
    if (out.team_id && !isUuid(out.team_id)) throw httpError(400, 'Time inválido.');
  }
  if (b.active !== undefined) out.active = !!b.active;
  return out;
}

app.post('/api/admin/usuarios', { preHandler: admin }, async (req) => {
  const d = readUserBody(req.body || {});
  if (await one('SELECT 1 FROM users WHERE email=$1', [d.email])) throw httpError(409, 'Já existe uma pessoa com este e-mail.');
  const u = await one(
    `INSERT INTO users(email,name,cargo,role,team_id) VALUES($1,$2,$3,$4,$5) RETURNING id,email,name`,
    [d.email, d.name, d.cargo || '', d.role, d.team_id || null]);
  return { usuario: u, ...(await issueLink(req, u, 'convite')) };
});

app.patch('/api/admin/usuarios/:id', { preHandler: admin }, async (req) => {
  const id = req.params.id;
  if (!isUuid(id)) throw httpError(400, 'Pessoa inválida.');
  const cur = await one('SELECT * FROM users WHERE id=$1', [id]);
  if (!cur) throw httpError(404, 'Pessoa não encontrada.');
  const d = readUserBody(req.body || {}, true);
  const losingAdmin = cur.role === 'admin' && ((d.role && d.role !== 'admin') || d.active === false);
  if (losingAdmin && (await activeAdmins(id)) === 0) throw httpError(400, 'É preciso manter pelo menos um administrador ativo.');
  if (d.email && d.email !== cur.email && (await one('SELECT 1 FROM users WHERE email=$1', [d.email])))
    throw httpError(409, 'Já existe uma pessoa com este e-mail.');
  const keys = Object.keys(d);
  if (keys.length) {
    await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...keys.map(k => d[k])]);
  }
  if (d.active === false) await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  return { ok: true };
});

app.post('/api/admin/usuarios/:id/link', { preHandler: admin }, async (req) => {
  if (!isUuid(req.params.id)) throw httpError(400, 'Pessoa inválida.');
  const u = await one('SELECT id,email,name,password_hash FROM users WHERE id=$1', [req.params.id]);
  if (!u) throw httpError(404, 'Pessoa não encontrada.');
  return issueLink(req, u, u.password_hash ? 'senha' : 'convite');
});

app.get('/api/admin/times', { preHandler: admin }, async (req) => ({ times: await visibleTeams(req.user) }));

function readTeamBody(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 120) throw httpError(400, 'Informe o nome do time.');
  const supervisor_id = b.supervisor_id || null;
  if (supervisor_id && !isUuid(supervisor_id)) throw httpError(400, 'Supervisor inválido.');
  return { name, supervisor_id };
}

app.post('/api/admin/times', { preHandler: admin }, async (req) => {
  const d = readTeamBody(req.body || {});
  const t = await one('INSERT INTO teams(name,supervisor_id) VALUES($1,$2) RETURNING id', [d.name, d.supervisor_id]);
  return { id: t.id };
});

app.patch('/api/admin/times/:id', { preHandler: admin }, async (req) => {
  if (!isUuid(req.params.id)) throw httpError(400, 'Time inválido.');
  const d = readTeamBody(req.body || {});
  await q('UPDATE teams SET name=$2,supervisor_id=$3 WHERE id=$1', [req.params.id, d.name, d.supervisor_id]);
  return { ok: true };
});

app.delete('/api/admin/times/:id', { preHandler: admin }, async (req) => {
  if (!isUuid(req.params.id)) throw httpError(400, 'Time inválido.');
  await q('DELETE FROM teams WHERE id=$1', [req.params.id]);
  return { ok: true };
});

// ---------- inicialização ----------
async function bootstrapAdmin() {
  const n = (await one('SELECT count(*)::int AS n FROM users')).n;
  if (n > 0) return;
  const email = cleanEmail(process.env.ADMIN_EMAIL);
  const pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) {
    app.log.warn('Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env para criar o primeiro administrador.');
    return;
  }
  const problem = passwordProblem(pw);
  if (problem) { app.log.error('ADMIN_PASSWORD inválida: ' + problem); return; }
  await q(`INSERT INTO users(email,name,cargo,role,password_hash) VALUES($1,$2,$3,'admin',$4)`,
    [email, process.env.ADMIN_NAME || 'Administrador', process.env.ADMIN_CARGO || '', await hashPassword(pw)]);
  app.log.info(`Administrador inicial criado: ${email}`);
}

// Limpeza periódica de sessões e links vencidos.
setInterval(() => {
  q('DELETE FROM sessions WHERE expires_at<now()').catch(() => {});
  q(`DELETE FROM tokens WHERE expires_at<now() - interval '30 days'`).catch(() => {});
}, 6 * 36e5).unref();

await migrate();
await bootstrapAdmin();
await app.listen({ port: PORT, host: '0.0.0.0' });
