import { pool } from '../db.js'

export default async function alertRoutes(app) {
  const admin = { preHandler: [app.requireAdmin] }
  const auth = { preHandler: [app.authenticate] }

  // Admin: lista todos os alertas (com nome do alvo)
  app.get('/', admin, async () => {
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.message, a.level, a.target_type, a.target_id, a.created_at,
        CASE a.target_type
          WHEN 'user' THEN (SELECT username FROM users WHERE id = a.target_id)
          WHEN 'group' THEN (SELECT name FROM groups WHERE id = a.target_id)
          ELSE 'Todos'
        END AS target_name
       FROM alerts a
       ORDER BY a.created_at DESC`
    )
    return rows
  })

  // Admin: cria um alerta (enviado pro app de quem se aplica)
  app.post('/', admin, async (req, reply) => {
    const { title, message, level, target_type, target_id } = req.body || {}
    if (!title || !message) {
      return reply.code(400).send({ error: 'título e mensagem são obrigatórios' })
    }
    const lv = ['info', 'warning', 'critical'].includes(level) ? level : 'info'
    const tt = ['all', 'user', 'group'].includes(target_type) ? target_type : 'all'
    const tid = tt === 'all' ? null : target_id || null
    const { rows } = await pool.query(
      `INSERT INTO alerts (title, message, level, target_type, target_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, message, lv, tt, tid]
    )
    return reply.code(201).send(rows[0])
  })

  app.delete('/:id', admin, async (req) => {
    await pool.query('DELETE FROM alerts WHERE id = $1', [req.params.id])
    return { ok: true }
  })

  // App do cliente: alertas que se aplicam ao usuário logado
  app.get('/mine', auth, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, title, message, level, created_at FROM alerts a
       WHERE a.target_type = 'all'
         OR (a.target_type = 'user' AND a.target_id = $1)
         OR (a.target_type = 'group' AND a.target_id IN (
              SELECT group_id FROM user_groups WHERE user_id = $1))
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [req.user.id]
    )
    return rows
  })
}
