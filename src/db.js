import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://metas:metas@localhost:5432/metas',
  max: 10,
});

export const q = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;

export async function migrate() {
  const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  // Tenta algumas vezes: no Docker o banco pode demorar alguns segundos para aceitar conexões.
  for (let i = 0; ; i++) {
    try { await pool.query(sql); return; }
    catch (e) {
      if (i >= 20 || !/ECONNREFUSED|starting up|ENOTFOUND|EAI_AGAIN/.test(String(e.message || e.code))) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}
