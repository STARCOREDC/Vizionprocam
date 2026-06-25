// CRUD de MORADORES CONHECIDOS (#3) — cada usuário gerencia os SEUS rostos.
//
// As fotos ficam em FACES_DIR (no banco, known_persons.photo guarda só o
// filename). O Guardião usa esses rostos pra reconhecer moradores e decidir
// entre alerta informativo (morador) e alerta crítico (desconhecido).
//
// Permissão: rotas VIEWER (qualquer usuário autenticado), mas SEMPRE restritas
// ao próprio dono (owner_user_id = req.user.id). Admin pode ver fotos de todos.
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { pool } from '../db.js'

const FACES_DIR = '/opt/vizionpro/faces'

// Limite de rostos por usuário (custo de armazenamento + precisão do match).
const MAX_PER_USER = 10
// Tamanho mínimo da imagem decodificada — abaixo disso provavelmente não é foto.
const MIN_IMAGE_BYTES = 500

// Decodifica o campo `photo` recebido: aceita data URL (data:image/...;base64,XXX)
// ou base64 puro. Retorna um Buffer, ou null se inválido.
function decodePhoto(photo) {
  try {
    if (typeof photo !== 'string' || !photo) return null
    // remove o prefixo data URL se houver
    const base64 = photo.includes(',') ? photo.slice(photo.indexOf(',') + 1) : photo
    const buf = Buffer.from(base64, 'base64')
    if (!buf || buf.length < MIN_IMAGE_BYTES) return null
    return buf
  } catch {
    return null
  }
}

export default async function faceRoutes(app) {
  const auth = { preHandler: [app.authenticate] }

  // Lista os moradores do próprio usuário.
  app.get('/', auth, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, name, (photo IS NOT NULL) AS "hasPhoto", created_at
       FROM known_persons
       WHERE owner_user_id = $1
       ORDER BY created_at ASC`,
      [req.user.id]
    )
    return rows
  })

  // Cadastra um novo morador. body { name, photo(base64) }. Máx MAX_PER_USER.
  app.post('/', auth, async (req, reply) => {
    const name = (req.body && req.body.name ? String(req.body.name) : '').trim()
    if (!name) return reply.code(400).send({ error: 'name obrigatório' })

    const buf = decodePhoto(req.body && req.body.photo)
    if (!buf) return reply.code(400).send({ error: 'foto inválida (base64 de imagem obrigatório)' })

    // limite por usuário — conta ANTES de gravar
    const { rows: cnt } = await pool.query(
      'SELECT count(*)::int AS c FROM known_persons WHERE owner_user_id = $1',
      [req.user.id]
    )
    if (cnt[0] && cnt[0].c >= MAX_PER_USER) {
      return reply.code(409).send({ error: `limite de ${MAX_PER_USER} moradores atingido` })
    }

    // nome do arquivo: <owner>-<timestamp>.jpg (único por usuário/instante)
    const filename = `${req.user.id}-${Date.now()}.jpg`
    try {
      await writeFile(join(FACES_DIR, filename), buf)
    } catch (e) {
      app.log.error({ err: e.message }, 'faces write')
      return reply.code(500).send({ error: 'falha ao salvar a foto' })
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO known_persons (owner_user_id, name, photo)
         VALUES ($1, $2, $3) RETURNING id, name`,
        [req.user.id, name, filename]
      )
      return reply.code(201).send(rows[0])
    } catch (e) {
      // se o INSERT falhar, remove o arquivo órfão pra não vazar disco
      await unlink(join(FACES_DIR, filename)).catch(() => {})
      app.log.error({ err: e.message }, 'faces insert')
      return reply.code(500).send({ error: 'falha ao cadastrar morador' })
    }
  })

  // Remove um morador (só se for do próprio usuário). Apaga arquivo + row.
  app.delete('/:id', auth, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT photo FROM known_persons WHERE id = $1 AND owner_user_id = $2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrado' })
    // apaga o arquivo (best-effort — não falha a operação se já sumiu)
    if (rows[0].photo) {
      await unlink(join(FACES_DIR, rows[0].photo)).catch(() => {})
    }
    await pool.query('DELETE FROM known_persons WHERE id = $1 AND owner_user_id = $2', [
      req.params.id,
      req.user.id,
    ])
    return { ok: true }
  })

  // Serve a foto do morador (image/jpeg). Só o dono — ou admin — pode ver.
  app.get('/:id/photo', auth, async (req, reply) => {
    const where =
      req.user.role === 'admin'
        ? ['SELECT photo FROM known_persons WHERE id = $1', [req.params.id]]
        : [
            'SELECT photo FROM known_persons WHERE id = $1 AND owner_user_id = $2',
            [req.params.id, req.user.id],
          ]
    const { rows } = await pool.query(where[0], where[1])
    if (!rows[0] || !rows[0].photo) return reply.code(404).send({ error: 'não encontrado' })
    try {
      const buf = await readFile(join(FACES_DIR, rows[0].photo))
      return reply.header('Cache-Control', 'private, max-age=3600').type('image/jpeg').send(buf)
    } catch {
      return reply.code(404).send({ error: 'foto indisponível' })
    }
  })
}
