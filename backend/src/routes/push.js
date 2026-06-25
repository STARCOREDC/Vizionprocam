import { registerToken, removeToken } from '../push.js'

// Rotas de gerenciamento do token de push do dispositivo (app mobile Expo).
// Ambas exigem usuário autenticado (o token fica vinculado a req.user.id).
export default async function pushRoutes(app) {
  const auth = { preHandler: [app.authenticate] }

  // App registra/atualiza o ExpoPushToken do aparelho ao logar/abrir.
  // body: { token, platform }  (platform ex 'ios'/'android')
  app.post('/register', auth, async (req, reply) => {
    const { token, platform } = req.body || {}
    if (!token) {
      return reply.code(400).send({ error: 'token é obrigatório' })
    }
    await registerToken(req.user.id, token, platform)
    return { ok: true }
  })

  // App remove o token ao deslogar (ou ao desativar notificações).
  // body: { token }
  app.post('/unregister', auth, async (req, reply) => {
    const { token } = req.body || {}
    if (!token) {
      return reply.code(400).send({ error: 'token é obrigatório' })
    }
    await removeToken(token)
    return { ok: true }
  })
}
