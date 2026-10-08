import { one, q } from './db.js';

/**
 * Regras de acesso (aplicadas no servidor):
 *  - cada pessoa vê e edita só os próprios dados;
 *  - o supervisor de um time vê (somente leitura) os dados das pessoas desse time;
 *  - o administrador vê tudo (somente leitura nos dados dos outros) e cadastra pessoas e times.
 */
export async function canView(viewer, ownerId) {
  if (!viewer) return false;
  if (viewer.id === ownerId || viewer.role === 'admin') return true;
  const r = await one(
    `SELECT 1 FROM users u JOIN teams t ON t.id=u.team_id
      WHERE u.id=$1 AND t.supervisor_id=$2`, [ownerId, viewer.id]);
  return !!r;
}

/** Pessoas que o usuário pode acompanhar (inclui ele mesmo). */
export async function visiblePeople(viewer) {
  const base = `SELECT u.id,u.name,u.email,u.cargo,u.role,u.team_id,t.name AS team_name,u.active,u.last_login_at
                  FROM users u LEFT JOIN teams t ON t.id=u.team_id`;
  if (viewer.role === 'admin') return (await q(base + ' ORDER BY t.name NULLS LAST,u.name')).rows;
  return (await q(base + ` WHERE u.id=$1 OR t.supervisor_id=$1 ORDER BY t.name NULLS LAST,u.name`, [viewer.id])).rows;
}

export async function visibleTeams(viewer) {
  const base = `SELECT t.id,t.name,t.supervisor_id,s.name AS supervisor_name,
                       (SELECT count(*)::int FROM users m WHERE m.team_id=t.id AND m.active) AS members
                  FROM teams t LEFT JOIN users s ON s.id=t.supervisor_id`;
  if (viewer.role === 'admin') return (await q(base + ' ORDER BY t.name')).rows;
  return (await q(base + ' WHERE t.supervisor_id=$1 ORDER BY t.name', [viewer.id])).rows;
}
