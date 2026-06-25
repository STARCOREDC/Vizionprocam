import { readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

import { pool } from '../db.js'

const EVENTS_DIR = '/opt/vizionpro/events'

export default async function eventRoutes(app) {
  const auth = { preHandler: [app.authenticate] }

  // Lista eventos de movimento.
  // Admin vê todos; viewer só de câmeras que tem permissão.
  // Query params: ?cameraId=&limit= (default 50, max 200)
  app.get('/', auth, async (req) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200)
    const cameraId = req.query?.cameraId || null

    const vals = []
    const where = []
    if (req.user.role !== 'admin') {
      vals.push(req.user.id)
      where.push(`(
        e.camera_id IN (SELECT camera_id FROM user_cameras WHERE user_id = $1)
        OR e.camera_id IN (
          SELECT cg.camera_id FROM camera_groups cg
          JOIN user_groups ug ON ug.group_id = cg.group_id
          WHERE ug.user_id = $1)
      )`)
    }
    if (cameraId) {
      vals.push(cameraId)
      where.push(`e.camera_id = $${vals.length}`)
    }
    vals.push(limit)

    const { rows } = await pool.query(
      `SELECT e.id, e.camera_id, c.name AS camera_name, e.type, e.started_at,
              e.ai_label, e.ai_description,
              (e.snapshot IS NOT NULL) AS "hasSnapshot"
       FROM events e
       JOIN cameras c ON c.id = e.camera_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.started_at DESC
       LIMIT $${vals.length}`,
      vals
    )
    return rows
  })

  // Snapshot (JPEG) de um evento — checa permissão pela câmera do evento
  app.get('/:id/snapshot', auth, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT camera_id, snapshot FROM events WHERE id = $1',
      [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'evento não encontrado' })
    const ev = rows[0]

    // viewer: só se enxerga a câmera do evento
    if (req.user.role !== 'admin') {
      const perm = await pool.query(
        `SELECT 1 FROM cameras c WHERE c.id = $2 AND (
           c.id IN (SELECT camera_id FROM user_cameras WHERE user_id = $1)
           OR c.id IN (
             SELECT cg.camera_id FROM camera_groups cg
             JOIN user_groups ug ON ug.group_id = cg.group_id WHERE ug.user_id = $1)
         ) LIMIT 1`,
        [req.user.id, ev.camera_id]
      )
      if (!perm.rows[0]) return reply.code(403).send({ error: 'sem permissão' })
    }

    if (!ev.snapshot) return reply.code(404).send({ error: 'evento sem snapshot' })
    try {
      // basename evita path traversal (no banco fica só o filename mesmo)
      const buf = await readFile(join(EVENTS_DIR, basename(ev.snapshot)))
      return reply.header('Cache-Control', 'private, max-age=3600').type('image/jpeg').send(buf)
    } catch {
      return reply.code(404).send({ error: 'snapshot não encontrado' })
    }
  })
}
