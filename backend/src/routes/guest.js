import { pool } from '../db.js'

// Rotas PÚBLICAS de acesso convidado (link temporário de câmera).
// Nenhuma rota aqui exige autenticação — a "credencial" é o token do share.
export default async function guestRoutes(app) {
  // Valida o token e devolve só o necessário pro player do convidado.
  // Token inválido/expirado/câmera desabilitada → 410 (link morto).
  app.get('/:token', async (req, reply) => {
    const token = String(req.params.token || '')
    if (!token) return reply.code(404).send({ error: 'Link expirado ou inválido' })
    try {
      const { rows } = await pool.query(
        `SELECT c.name, c.slug, c.location, s.expires_at
         FROM camera_shares s
         JOIN cameras c ON c.id = s.camera_id
         WHERE s.token = $1 AND s.expires_at > now() AND c.enabled = true
         LIMIT 1`,
        [token]
      )
      if (!rows[0]) return reply.code(410).send({ error: 'Link expirado ou inválido' })
      const r = rows[0]
      return {
        camera: { name: r.name, slug: r.slug, location: r.location },
        expiresAt: r.expires_at,
      }
    } catch (e) {
      app.log.error({ err: e.message }, 'guest token')
      return reply.code(410).send({ error: 'Link expirado ou inválido' })
    }
  })
}
