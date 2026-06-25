import { pool } from './db.js'

// Sessão única por usuário (anti-compartilhamento).
// cache em memória: userId -> session_id atual. O banco é a fonte da verdade
// (resiliente a restart): se o cache não tem, carrega do banco.
const cache = new Map()

export function setSession(userId, sid) {
  cache.set(Number(userId), sid)
}

export async function isValidSession(userId, sid) {
  if (!sid) return false
  const uid = Number(userId)
  let cur = cache.get(uid)
  if (cur === undefined) {
    const { rows } = await pool.query('SELECT session_id FROM users WHERE id = $1', [uid])
    cur = rows[0] ? rows[0].session_id : null
    cache.set(uid, cur)
  }
  return cur === sid
}
