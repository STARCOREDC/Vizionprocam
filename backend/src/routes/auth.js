import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { pool } from '../db.js'
import { setSession } from '../sessions.js'

export default async function authRoutes(app) {
  app.post('/login', async (req, reply) => {
    const { username, password } = req.body || {}
    if (!username || !password) {
      return reply.code(400).send({ error: 'usuário e senha obrigatórios' })
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username])
    const u = rows[0]
    if (!u || !bcrypt.compareSync(password, u.password_hash)) {
      return reply.code(401).send({ error: 'credenciais inválidas' })
    }
    // sessão única: novo login invalida o token do aparelho anterior
    const sid = randomBytes(12).toString('hex')
    await pool.query('UPDATE users SET session_id = $1 WHERE id = $2', [sid, u.id])
    setSession(u.id, sid)

    const token = app.jwt.sign(
      { id: u.id, username: u.username, role: u.role, sid },
      { expiresIn: '30d' }
    )
    // cookie p/ autorizar os streams (/hls e /playback) no navegador (httpOnly)
    reply.header(
      'Set-Cookie',
      `vp_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`
    )
    return { token, user: { id: u.id, username: u.username, role: u.role } }
  })

  app.get('/me', { preHandler: [app.authenticate] }, async (req) => req.user)

  // Troca da própria senha (qualquer usuário autenticado)
  app.post('/change-password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body || {}
    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ error: 'senha atual e nova são obrigatórias' })
    }
    if (String(newPassword).length < 4) {
      return reply.code(400).send({ error: 'a nova senha deve ter ao menos 4 caracteres' })
    }
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])
    const u = rows[0]
    if (!u || !bcrypt.compareSync(currentPassword, u.password_hash)) {
      return reply.code(401).send({ error: 'senha atual incorreta' })
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      bcrypt.hashSync(newPassword, 10),
      req.user.id,
    ])
    return { ok: true }
  })
}
