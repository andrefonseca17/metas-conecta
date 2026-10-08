#!/usr/bin/env node
// Gera um link para criar uma nova senha, direto no servidor.
// Útil quando o único administrador esqueceu a senha.
//
// Uso (dentro do Docker):
//   docker compose exec app node scripts/nova-senha.js --email andre@empresa.com.br
import { pool, one, migrate } from '../src/db.js';
import { createLinkToken } from '../src/auth.js';

const args = process.argv.slice(2);
const i = args.indexOf('--email');
const email = String(i >= 0 ? args[i + 1] : '').trim().toLowerCase();

async function main() {
  if (!email) throw new Error('Informe --email da pessoa.');
  await migrate();
  const u = await one('SELECT id,name,password_hash,active FROM users WHERE email=$1', [email]);
  if (!u) throw new Error(`Não existe pessoa com o e-mail ${email}.`);
  if (!u.active) throw new Error('Esta pessoa está desativada. Ative-a antes de gerar o link.');
  const token = await createLinkToken(u.id, u.password_hash ? 'senha' : 'convite');
  const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  console.log(`Link para ${u.name} (vale ${u.password_hash ? '2 horas' : '7 dias'}, uso único):\n${base}/definir-senha?token=${token}`);
}

main().catch(e => { console.error('Erro: ' + e.message); process.exitCode = 1; }).finally(() => pool.end());
