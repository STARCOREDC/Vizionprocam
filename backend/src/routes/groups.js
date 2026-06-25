import { pool } from '../db.js'

export default async function groupRoutes(app) {
  const admin = { preHandler: [app.requireAdmin] }

  app.get('/', admin, async () => {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.created_at,
        COALESCE((SELECT count(*) FROM camera_groups cg WHERE cg.group_id = g.id), 0)::int AS camera_count,
        COALESCE((SELECT count(*) FROM user_groups ug WHERE ug.group_id = g.id), 0)::int AS user_count,
        COALESCE((SELECT array_agg(u.username ORDER BY u.username)
                  FROM user_groups ug JOIN users u ON u.id = ug.user_id
                  WHERE ug.group_id = g.id), '{}') AS user_names
       FROM groups g ORDER BY g.name`
    )
    return rows
  })

  app.get('/:id', admin, async (req, reply) => {
    const { rows } = await pool.query('SELECT id, name, created_at FROM groups WHERE id = $1', [
      req.params.id,
    ])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrado' })
    const cameraIds = (
      await pool.query('SELECT camera_id FROM camera_groups WHERE group_id = $1', [req.params.id])
    ).rows.map((r) => r.camera_id)
    const userIds = (
      await pool.query('SELECT user_id FROM user_groups WHERE group_id = $1', [req.params.id])
    ).rows.map((r) => r.user_id)
    return { ...rows[0], cameraIds, userIds }
  })

  // Define quais usuários pertencem ao grupo (substitui o conjunto)
  app.put('/:id/users', admin, async (req) => {
    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds : []
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM user_groups WHERE group_id = $1', [req.params.id])
      for (const uid of ids) {
        await client.query(
          'INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [uid, req.params.id]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return { ok: true, userIds: ids }
  })

  app.post('/', admin, async (req, reply) => {
    const { name } = req.body || {}
    if (!name) return reply.code(400).send({ error: 'name obrigatório' })
    try {
      const { rows } = await pool.query(
        'INSERT INTO groups (name) VALUES ($1) RETURNING id, name, created_at',
        [name]
      )
      return reply.code(201).send(rows[0])
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'grupo já existe' })
      throw e
    }
  })

  app.patch('/:id', admin, async (req, reply) => {
    const { name } = req.body || {}
    if (!name) return reply.code(400).send({ error: 'name obrigatório' })
    const { rows } = await pool.query(
      'UPDATE groups SET name = $1 WHERE id = $2 RETURNING id, name',
      [name, req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrado' })
    return rows[0]
  })

  app.delete('/:id', admin, async (req) => {
    await pool.query('DELETE FROM groups WHERE id = $1', [req.params.id])
    return { ok: true }
  })

  // Define quais câmeras pertencem ao grupo (substitui o conjunto)
  app.put('/:id/cameras', admin, async (req) => {
    const ids = Array.isArray(req.body?.cameraIds) ? req.body.cameraIds : []
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM camera_groups WHERE group_id = $1', [req.params.id])
      for (const cid of ids) {
        await client.query(
          'INSERT INTO camera_groups (camera_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [cid, req.params.id]
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
