import { pool } from './db.js'

const KEY = 'whatsapp'

export async function getWaConfig() {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [KEY])
  return rows[0] ? rows[0].value : null
}

export async function setWaConfig(cfg) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, cfg]
  )
}

// Busca os grupos da instância (pra escolher o destino num dropdown).
// Aceita override (config ainda não salva) ou usa a config salva.
export async function fetchWaGroups(override) {
  const cfg = override && override.baseUrl ? override : await getWaConfig()
  if (!cfg || !cfg.baseUrl || !cfg.instance || !cfg.apiKey) {
    return { ok: false, error: 'Preencha URL, instância e API Key primeiro.' }
  }
  const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/group/fetchAllGroups/${encodeURIComponent(
    cfg.instance
  )}?getParticipants=false`
  try {
    const res = await fetch(url, { headers: { apikey: cfg.apiKey } })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, error: `Evolution respondeu ${res.status}`, body: t.slice(0, 200) }
    }
    const data = await res.json()
    const arr = Array.isArray(data) ? data : data.groups || []
    const groups = arr
      .map((g) => ({ id: g.id || g.jid, name: g.subject || g.name || g.id }))
      .filter((g) => g.id)
    return { ok: true, groups }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Envia texto via Evolution API. target opcional (senão usa o destino configurado).
export async function sendWhatsApp(text, target) {
  const cfg = await getWaConfig()
  if (!cfg || !cfg.enabled || !cfg.baseUrl || !cfg.instance || !cfg.apiKey) {
    return { ok: false, error: 'WhatsApp não configurado/desativado' }
  }
  const to = target || cfg.target
  if (!to) return { ok: false, error: 'destino (grupo/número) não configurado' }
  const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(
    cfg.instance
  )}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
      body: JSON.stringify({ number: to, text }),
    })
    const body = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, body: body.slice(0, 300) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
