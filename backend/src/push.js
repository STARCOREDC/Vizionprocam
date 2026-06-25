import { pool } from './db.js'

// ============================================================================
// PUSH NOTIFICATIONS via Expo Push Service (gratuito).
//
// O app mobile (Expo) registra seu ExpoPushToken (ex "ExponentPushToken[xxx]")
// na tabela push_tokens. Quando o backend cria um alerta in-app pra um conjunto
// de usuários, dispara TAMBÉM um push pros dispositivos desses usuários.
//
// O envio é SEMPRE best-effort: nada aqui pode lançar/quebrar o fluxo de alerta.
// Por isso TODAS as funções engolem erros (try/catch generoso) e só logam.
// ============================================================================

// Endpoint do Expo Push API (aceita um array de mensagens por POST).
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Máximo de mensagens por requisição recomendado pelo Expo (chunk de 100).
const CHUNK_SIZE = 100

// Timeout de rede do POST pro Expo (10s) — não trava o processo se o Expo penar.
const FETCH_TIMEOUT_MS = 10_000

// Registra (ou atualiza) o token de um dispositivo.
// Um token pertence a UM usuário: se o mesmo aparelho logar em outra conta,
// o ON CONFLICT atualiza o dono (user_id) e a plataforma.
export async function registerToken(userId, token, platform) {
  if (!userId || !token) return
  try {
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token)
       DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
      [userId, String(token), platform ? String(platform) : null]
    )
  } catch (e) {
    console.error('[push] registerToken:', e.message)
  }
}

// Remove um token (logout/desinstalação ou token inválido detectado pelo Expo).
export async function removeToken(token) {
  if (!token) return
  try {
    await pool.query(`DELETE FROM push_tokens WHERE token = $1`, [String(token)])
  } catch (e) {
    console.error('[push] removeToken:', e.message)
  }
}

// Retorna os tokens (array de strings) de um conjunto de usuários.
// Vazio em qualquer caso de erro ou lista vazia.
export async function tokensForUsers(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return []
  try {
    const { rows } = await pool.query(
      `SELECT token FROM push_tokens WHERE user_id = ANY($1::int[])`,
      [userIds]
    )
    return rows.map((r) => r.token).filter(Boolean)
  } catch (e) {
    console.error('[push] tokensForUsers:', e.message)
    return []
  }
}

// Divide um array em pedaços de tamanho `size`.
function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Faz UM POST pro Expo com um lote de mensagens. Devolve a lista de "tickets"
// (data[]) da resposta, ou [] em qualquer falha. Nunca lança.
async function postChunk(messages) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.error(`[push] Expo respondeu HTTP ${res.status}`)
      return []
    }
    const json = await res.json().catch(() => null)
    // Expo devolve { data: [ {status, message, details}, ... ] } na ordem enviada
    return Array.isArray(json?.data) ? json.data : []
  } catch (e) {
    // abort (timeout) ou erro de rede — best-effort, só loga
    console.error('[push] POST Expo falhou:', e.message)
    return []
  } finally {
    clearTimeout(timer)
  }
}

// Envia uma push pra todos os dispositivos de um conjunto de usuários.
// `payload`: { title, body, data }. Mesmo texto/usuários do alerta in-app.
// Best-effort: nunca lança. Limpa tokens inválidos ("DeviceNotRegistered").
export async function sendPushToUsers(userIds, { title, body, data } = {}) {
  try {
    const tokens = await tokensForUsers(userIds)
    if (!tokens.length) return

    // monta uma mensagem por token (alta prioridade + som padrão)
    const messages = tokens.map((to) => ({
      to,
      title: title || 'VizionPro',
      body: body || '',
      data: data || {},
      sound: 'default',
      priority: 'high',
    }))

    let sent = 0
    // envia em lotes de até 100; cada lote é independente
    for (const batch of chunk(messages, CHUNK_SIZE)) {
      const tickets = await postChunk(batch)
      sent += batch.length
      // varre os tickets pra detectar tokens que não existem mais no dispositivo.
      // tickets[i] corresponde a batch[i] (mesma ordem) -> limpamos o token.
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i]
        if (t && t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          const badToken = batch[i]?.to
          if (badToken) await removeToken(badToken)
        }
      }
    }

    console.log(`[push] enviado a ${sent} dispositivos`)
  } catch (e) {
    // push é ADICIONAL ao alerta in-app — qualquer erro aqui é só logado
    console.error('[push] sendPushToUsers:', e.message)
  }
}
