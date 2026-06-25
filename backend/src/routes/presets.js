// CRUD dos presets de detecção (detection_presets) — usados como FOCO do
// Modo Guardião (o que a IA procura). Só ADMIN gerencia. Presets builtin
// (builtin=true) não podem ser deletados (mas podem ser editados).
import { pool } from '../db.js'

// normaliza a key: minúscula, sem acento, só [a-z0-9-]
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default async function presetRoutes(app) {
  const admin = { preHandler: [app.requireAdmin] }

  // Lista todos os presets (builtin primeiro, depois por nome)
  app.get('/', admin, async () => {
    const { rows } = await pool.query(
      'SELECT id, key, name, emoji, prompt, builtin, created_at FROM detection_presets ORDER BY builtin DESC, name'
    )
    return rows
  })

  // Cria um preset { key, name, emoji, prompt }
  app.post('/', admin, async (req, reply) => {
    const body = req.body || {}
    const key = normKey(body.key || body.name)
    const name = (body.name || '').trim()
    const emoji = (body.emoji || '🎯').trim()
    const prompt = (body.prompt || '').trim()
    if (!key) return reply.code(400).send({ error: 'key/nome inválido' })
    if (!name) return reply.code(400).send({ error: 'name obrigatório' })
    if (!prompt) return reply.code(400).send({ error: 'prompt obrigatório' })
    try {
      const { rows } = await pool.query(
        `INSERT INTO detection_presets (key, name, emoji, prompt, builtin)
         VALUES ($1, $2, $3, $4, false)
         RETURNING id, key, name, emoji, prompt, builtin, created_at`,
        [key, name, emoji, prompt]
      )
      return reply.code(201).send(rows[0])
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'já existe preset com essa key' })
      app.log.error({ err: e.message }, 'preset create')
      return reply.code(500).send({ error: 'falha ao criar preset' })
    }
  })

  // Edita um preset (name, emoji, prompt e opcionalmente key). builtin permanece.
  app.put('/:id', admin, async (req, reply) => {
    const body = req.body || {}
    const sets = []
    const vals = []
    if ('name' in body) {
      const name = (body.name || '').trim()
      if (!name) return reply.code(400).send({ error: 'name vazio' })
      sets.push(`name = $${sets.length + 1}`)
      vals.push(name)
    }
    if ('emoji' in body) {
      sets.push(`emoji = $${sets.length + 1}`)
      vals.push((body.emoji || '🎯').trim())
    }
    if ('prompt' in body) {
      const prompt = (body.prompt || '').trim()
      if (!prompt) return reply.code(400).send({ error: 'prompt vazio' })
      sets.push(`prompt = $${sets.length + 1}`)
      vals.push(prompt)
    }
    if ('key' in body) {
      const key = normKey(body.key)
      if (!key) return reply.code(400).send({ error: 'key inválida' })
      sets.push(`key = $${sets.length + 1}`)
      vals.push(key)
    }
    if (!sets.length) return reply.code(400).send({ error: 'nada para atualizar' })
    vals.push(req.params.id)
    try {
      const { rows } = await pool.query(
        `UPDATE detection_presets SET ${sets.join(', ')}
         WHERE id = $${vals.length}
         RETURNING id, key, name, emoji, prompt, builtin, created_at`,
        vals
      )
      if (!rows[0]) return reply.code(404).send({ error: 'não encontrado' })
      return rows[0]
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'já existe preset com essa key' })
      app.log.error({ err: e.message }, 'preset update')
      return reply.code(500).send({ error: 'falha ao atualizar preset' })
    }
  })

  // Deleta um preset — só se builtin = false
  app.delete('/:id', admin, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT builtin FROM detection_presets WHERE id = $1',
      [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrado' })
    if (rows[0].builtin) return reply.code(400).send({ error: 'preset padrão não pode ser removido' })
    await pool.query('DELETE FROM detection_presets WHERE id = $1', [req.params.id])
    return { ok: true }
  })
}
