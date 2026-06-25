import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import cors from '@fastify/cors'

import { pool } from './db.js'
import { isValidSession } from './sessions.js'
import authRoutes from './routes/auth.js'
import cameraRoutes from './routes/cameras.js'
import groupRoutes from './routes/groups.js'
import userRoutes from './routes/users.js'
import alertRoutes from './routes/alerts.js'
import reportRoutes from './routes/reports.js'
import integrationRoutes from './routes/integrations.js'
import presetRoutes from './routes/presets.js'
import eventRoutes from './routes/events.js'
import guestRoutes from './routes/guest.js'
import faceRoutes from './routes/faces.js'
import pushRoutes from './routes/push.js'
import playbackRoutes from './routes/playback.js'
import { syncAllCameras } from './mediamtx.js'
import { startHealthMonitor } from './health.js'
import { startMotionEngine } from './motion.js'
import { startGuardian } from './guardian.js'
import { startReportScheduler } from './report.js'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
await app.register(jwt, { secret: process.env.JWT_SECRET || 'troque-este-segredo' })

app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'não autenticado' })
  }
  // sessão única (anti-compartilhamento) — só para clientes (viewer)
  if (req.user.role === 'viewer' && !(await isValidSession(req.user.id, req.user.sid))) {
    return reply.code(401).send({ error: 'sessão encerrada em outro dispositivo', code: 'session_revoked' })
  }
})
app.decorate('requireAdmin', async (req, reply) => {
  try {
    await req.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'não autenticado' })
  }
  if (req.user.role !== 'admin') {
    return reply.code(403).send({ error: 'acesso restrito a administradores' })
  }
})

app.get('/api/health', async () => ({ ok: true, ts: Date.now() }))

// --- Autorização de stream (chamada pelo nginx via auth_request) ---
function cookieVal(cookieHeader, name) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}
function slugFromUri(uri) {
  if (!uri) return null
  const [path, query] = uri.split('?')
  if (path.startsWith('/hls/')) {
    const parts = path.split('/').filter(Boolean) // ['hls', '<slug>', ...]
    return parts[1] ? decodeURIComponent(parts[1]) : null
  }
  if (path.startsWith('/playback/')) {
    return new URLSearchParams(query || '').get('path')
  }
  return null
}

app.get('/api/stream-auth', async (req, reply) => {
  const auth = req.headers['authorization'] || ''
  const token =
    cookieVal(req.headers.cookie, 'vp_token') ||
    (req.query && req.query.token) ||
    (auth.startsWith('Bearer ') ? auth.slice(7) : null)
  const slug = slugFromUri(req.headers['x-original-uri'] || req.url)

  // Sem token de usuário: tenta acesso convidado (link temporário).
  // O token de convidado só autoriza a câmera do próprio share.
  if (!token) {
    const guest = cookieVal(req.headers.cookie, 'vp_guest') || (req.query && req.query.guest)
    if (!guest || !slug) return reply.code(401).send()
    try {
      // path '<slug>-sd' (stream secundário) também pertence à câmera base
      const base = slug.endsWith('-sd') ? slug.slice(0, -3) : slug
      const { rows } = await pool.query(
        `SELECT 1 FROM camera_shares s
         JOIN cameras c ON c.id = s.camera_id
         WHERE s.token = $1 AND s.expires_at > now() AND c.enabled = true
           AND (c.slug = $2 OR c.slug = $3)
         LIMIT 1`,
        [guest, slug, base]
      )
      return reply.code(rows[0] ? 200 : 401).send()
    } catch {
      return reply.code(401).send()
    }
  }

  let payload
  try {
    payload = app.jwt.verify(token)
  } catch {
    return reply.code(401).send()
  }
  // sessão única (viewer): token de aparelho deslogado não acessa stream
  if (payload.role === 'viewer' && !(await isValidSession(payload.id, payload.sid))) {
    return reply.code(401).send()
  }
  if (!slug) return reply.code(403).send()
  if (payload.role === 'admin') return reply.code(200).send()
  const hasPerm = async (s) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM cameras c
       WHERE c.slug = $2 AND c.enabled = true AND (
         c.id IN (SELECT camera_id FROM user_cameras WHERE user_id = $1)
         OR c.id IN (
           SELECT cg.camera_id FROM camera_groups cg
           JOIN user_groups ug ON ug.group_id = cg.group_id
           WHERE ug.user_id = $1
         )
       ) LIMIT 1`,
      [payload.id, s]
    )
    return !!rows[0]
  }
  let allowed = await hasPerm(slug)
  // Stream secundário SD: o path é `<slug>-sd` mas a permissão é da câmera base.
  // Se não autorizou com o slug exato, tenta sem o sufixo '-sd'.
  if (!allowed && slug.endsWith('-sd')) {
    allowed = await hasPerm(slug.slice(0, -3))
  }
  return reply.code(allowed ? 200 : 403).send()
})

app.get('/api/stats', { preHandler: [app.requireAdmin] }, async () => {
  const c = async (sql) => Number((await pool.query(sql)).rows[0].c)
  return {
    users: await c('SELECT count(*) c FROM users'),
    cameras: await c('SELECT count(*) c FROM cameras'),
    groups: await c('SELECT count(*) c FROM groups'),
    recordingsEnabled: await c('SELECT count(*) c FROM cameras WHERE record = true'),
  }
})

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(cameraRoutes, { prefix: '/api/cameras' })
await app.register(groupRoutes, { prefix: '/api/groups' })
await app.register(userRoutes, { prefix: '/api/users' })
await app.register(alertRoutes, { prefix: '/api/alerts' })
await app.register(reportRoutes, { prefix: '/api/reports' })
await app.register(integrationRoutes, { prefix: '/api/integrations' })
await app.register(presetRoutes, { prefix: '/api/detection-presets' })
await app.register(eventRoutes, { prefix: '/api/events' })
await app.register(faceRoutes, { prefix: '/api/known-persons' }) // moradores conhecidos
await app.register(pushRoutes, { prefix: '/api/push' })
  await app.register(playbackRoutes, { prefix: '/_playback' }) // registro de push tokens
await app.register(guestRoutes, { prefix: '/api/guest' }) // público (link de convidado)

const port = Number(process.env.PORT || 4000)
const host = process.env.HOST || '127.0.0.1'

try {
  await app.listen({ port, host })
  syncAllCameras().catch((e) => app.log.error({ err: e.message }, 'sync mediamtx falhou'))
  startHealthMonitor()
  startMotionEngine()
  startGuardian()
  startReportScheduler()
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
