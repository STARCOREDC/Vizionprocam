import bcrypt from 'bcryptjs'
import { pool } from '../db.js'

export default async function userRoutes(app) {
  const admin = { preHandler: [app.requireAdmin] }

  app.get('/', admin, async () => {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role, u.created_at,
        COALESCE((SELECT count(*) FROM user_groups ug WHERE ug.user_id = u.id), 0)::int AS group_count,
        COALESCE((SELECT count(*) FROM user_cameras uc WHERE uc.user_id = u.id), 0)::int AS camera_count
       FROM users u ORDER BY u.username`
    )
    return rows
  })

  app.get('/:id', admin, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT id, username, role, created_at FROM users WHERE id = $1',
      [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrado' })
    const groupIds = (
      await pool.query('SELECT group_id FROM user_groups WHERE user_id = $1', [req.params.id])
    ).rows.map((r) => r.group_id)
    const cameraIds = (
      await pool.query('SELECT camera_id FROM user_cameras WHERE user_id = $1', [req.params.id])
    ).rows.map((r) => r.camera_id)
    return { ...rows[0], groupIds, cameraIds }
  })

  app.post('/', admin, async (req, reply) => {
    const { username, password, role } = req.body || {}
    if (!username || !password) {
      return reply.code(400).send({ error: 'username e password obrigatórios' })
    }
    const r = role === 'admin' ? 'admin' : 'viewer'
    const hash = bcrypt.hashSync(password, 10)
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)
         RETURNING id, username, role, created_at`,
        [username, hash, r]
      )
      return reply.code(201).send(rows[0])
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'usuário já existe' })
      throw e
    }
  })

  app.patch('/:id', admin, async (req, reply) => {
    const { password, role } = req.body || {}
    const sets = []
    const vals = []
    if (password) {
      sets.push(`password_hash = $${sets.length + 1}`)
      vals.push(bcrypt.hashSync(password, 10))
    }
    if (role) {
      sets.push(`role = $${sets.length + 1}`)
      vals.push(role === 'admin' ? 'admin' : 'viewer')
    }
    if (!sets.length) return reply.code(400).send({ error: 'nada para atualizar' })
    vals.push(req.params.id)
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, username, role`,
      vals
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrado' })
    return rows[0]
  })

  app.delete('/:id', admin, async (req, reply) => {
    if (Number(req.params.id) === req.user.id) {
      return reply.code(400).send({ error: 'não pode excluir o próprio usuário' })
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id])
    return { ok: true }
  })

  // Vincula o usuário a grupos (vê as câmeras desses grupos)
  app.put('/:id/groups', admin, async (req) => {
    const ids = Array.isArray(req.body?.groupIds) ? req.body.groupIds : []
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM user_groups WHERE user_id = $1', [req.params.id])
      for (const gid of ids) {
        await client.query(
          'INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [req.params.id, gid]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return { ok: true, groupIds: ids }
  })

  // Vincula o usuário a câmeras avulsas (acesso direto a uma câmera específica)
  app.put('/:id/cameras', admin, async (req) => {
    const ids = Array.isArray(req.body?.cameraIds) ? req.body.cameraIds : []
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM user_cameras WHERE user_id = $1', [req.params.id])
      for (const cid of ids) {
        await client.query(
          'INSERT INTO user_cameras (user_id, camera_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [req.params.id, cid]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return { ok: true, cameraIds: ids }
  })
}
