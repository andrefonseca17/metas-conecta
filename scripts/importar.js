#!/usr/bin/env node
// Importa as metas exportadas do painel antigo para a conta de uma pessoa.
//
// Uso (dentro do Docker):
//   docker compose exec app node scripts/importar.js --email andre@empresa.com.br --pasta migracao
//
// A pasta precisa ter:
//   dados.json   (metas, importações do Trello e configurações)
//   fotos/       (opcional: arquivos de foto com o nome igual ao id usado nas metas)
//
// Opções:
//   --substituir   apaga as metas/configurações atuais da pessoa antes de importar
import fs from 'node:fs';
import path from 'node:path';
import { pool, q, one, migrate } from '../src/db.js';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const flag = n => args.includes('--' + n);

const email = String(opt('email') || '').trim().toLowerCase();
const dir = path.resolve(opt('pasta') || 'migracao');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
  return null;
}

async function main() {
  if (!email) throw new Error('Informe --email da pessoa que vai receber as metas.');
  const file = path.join(dir, 'dados.json');
  if (!fs.existsSync(file)) throw new Error(`Não encontrei ${file}.`);
  await migrate();
  const user = await one('SELECT id,name FROM users WHERE email=$1', [email]);
  if (!user) throw new Error(`Não existe pessoa cadastrada com o e-mail ${email}. Cadastre-a na Administração primeiro.`);
  const dados = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (flag('substituir')) {
    await q('DELETE FROM docs WHERE owner_id=$1', [user.id]);
    console.log('Dados anteriores da pessoa apagados.');
  }

  // Fotos: copia cada arquivo e troca o id antigo pelo novo dentro das metas.
  const fotosDir = path.join(dir, 'fotos');
  const idMap = {};
  if (fs.existsSync(fotosDir)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const name of fs.readdirSync(fotosDir)) {
      const buf = fs.readFileSync(path.join(fotosDir, name));
      const mime = sniff(buf);
      if (!mime) { console.warn(`Ignorando ${name}: não é uma imagem.`); continue; }
      const row = await one('INSERT INTO photos(owner_id,mime,size) VALUES($1,$2,$3) RETURNING id', [user.id, mime, buf.length]);
      fs.writeFileSync(path.join(UPLOAD_DIR, row.id), buf);
      idMap[name.replace(/\.[^.]+$/, '')] = row.id;
    }
  }

  let nGoals = 0, nFotos = 0;
  for (const g of dados.goals || []) {
    const doc = { ...g };
    if (Array.isArray(doc.fotos)) {
      doc.fotos = doc.fotos.filter(f => idMap[f.id]).map(f => { nFotos++; return { ...f, id: idMap[f.id] }; });
    }
    await q(`INSERT INTO docs(owner_id,coll,doc_id,data) VALUES($1,'goals',$2,$3)
             ON CONFLICT (owner_id,coll,doc_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [user.id, String(g.id), doc]);
    nGoals++;
  }
  for (const b of dados.boards || []) {
    await q(`INSERT INTO docs(owner_id,coll,doc_id,data) VALUES($1,'boards',$2,$3)
             ON CONFLICT (owner_id,coll,doc_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [user.id, String(b.id || b.ano), b]);
  }
  for (const [key, val] of Object.entries(dados.settings || {})) {
    await q(`INSERT INTO docs(owner_id,coll,doc_id,data) VALUES($1,'settings',$2,$3)
             ON CONFLICT (owner_id,coll,doc_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [user.id, key, val]);
  }
  console.log(`Pronto: ${nGoals} metas/ideias e ${nFotos} fotos importadas para ${user.name} (${email}).`);
}

main().catch(e => { console.error('Erro: ' + e.message); process.exitCode = 1; }).finally(() => pool.end());
