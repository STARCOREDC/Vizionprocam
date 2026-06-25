import onvif from 'onvif'
import { writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { pool } from './db.js'
import { getSnapshot } from './mediamtx.js'

const { Cam } = onvif

// Diretório onde os snapshots dos eventos são salvos (no banco fica só o filename)
const EVENTS_DIR = '/opt/vizionpro/events'

// Debounces (por câmera)
const EVENT_DEBOUNCE_MS = 30_000 // máx. 1 evento a cada 30s
const ALERT_DEBOUNCE_MS = 300_000 // máx. 1 alerta in-app a cada 5 min

// Map de conexões ativas: cameraId -> { cam, lastEventAt, lastAlertAt, info }
const active = new Map()
let started = false

// Extrai credenciais e IP de uma URL RTSP (rtsp://user:pass@ip:port/...).
// A senha pode ser vazia; creds vêm URL-encoded, então decodifica.
export function parseRtsp(url) {
  const m = String(url || '').match(
    /^rtsp:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/:?]+)/i
  )
  if (!m) return { username: '', password: '', ip: null }
  const dec = (s) => {
    try {
      return decodeURIComponent(s || '')
    } catch {
      return s || ''
    }
  }
  return { username: dec(m[1]), password: dec(m[2]), ip: m[3] || null }
}

// usuários (viewer) que podem ver a câmera — p/ alerta in-app (mesma lógica do health.js)
async function usersForCamera(cameraId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.username FROM users u WHERE u.role = 'viewer' AND (
       u.id IN (SELECT user_id FROM user_cameras WHERE camera_id = $1)
       OR u.id IN (
         SELECT ug.user_id FROM user_groups ug
         JOIN camera_groups cg ON cg.group_id = ug.group_id
         WHERE cg.camera_id = $1)
     )`,
    [cameraId]
  )
  return rows
}

// O topic do evento ONVIF indica movimento? (ex.: tns1:RuleEngine/CellMotionDetector/Motion)
function isMotionTopic(topic) {
  const t = String(topic || '').toLowerCase()
  return t.includes('motion') || t.includes('cellmotiondetector')
}

// Procura no payload do evento o valor do movimento (IsMotion/State/Motion = true)
function motionValue(msg) {
  try {
    let items = msg?.message?.message?.data?.simpleItem
    if (!items) return false
    if (!Array.isArray(items)) items = [items]
    for (const it of items) {
      const name = it?.$?.Name
      if (['IsMotion', 'State', 'Motion'].includes(name)) {
        const v = it?.$?.Value
        return v === true || v === 'true'
      }
    }
  } catch {
    // payload fora do esperado — ignora
  }
  return false
}

// Movimento confirmado: snapshot + INSERT em events + alerta in-app (com debounces)
async function onMotion(entry) {
  const now = Date.now()
  const cam = entry.info // { id, name, slug }

  // debounce de evento: máx. 1 a cada 30s por câmera
  if (now - entry.lastEventAt < EVENT_DEBOUNCE_MS) return
  entry.lastEventAt = now

  console.log(`[motion] movimento na câmera ${cam.name} (${cam.slug})`)

  // (a) snapshot do stream local — se falhar, segue sem imagem
  let snapshot = null
  try {
    const buf = await getSnapshot(cam.slug)
    const filename = `${cam.slug}-${now}.jpg`
    await writeFile(join(EVENTS_DIR, filename), buf)
    snapshot = filename
  } catch (e) {
    console.log(`[motion] snapshot falhou (${cam.slug}): ${e.message}`)
  }

  // (b) registra o evento
  try {
    await pool.query(
      `INSERT INTO events (camera_id, type, snapshot) VALUES ($1, 'motion', $2)`,
      [cam.id, snapshot]
    )
  } catch (e) {
    console.error(`[motion] insert event (${cam.slug}):`, e.message)
  }

  // (c) alerta in-app — debounce maior: 1 por câmera a cada 5 min
  if (now - entry.lastAlertAt < ALERT_DEBOUNCE_MS) return
  entry.lastAlertAt = now
  try {
    const users = await usersForCamera(cam.id)
    for (const u of users) {
      await pool
        .query(
          `INSERT INTO alerts (title, message, level, target_type, target_id)
           VALUES ($1, $2, 'warning', 'user', $3)`,
          ['Movimento detectado', `Movimento na câmera "${cam.name}".`, u.id]
        )
        .catch(() => {})
    }
  } catch (e) {
    console.error(`[motion] alerta (${cam.slug}):`, e.message)
  }
}

// Conecta no ONVIF da câmera e assina os eventos (pullpoint automático da lib)
function connectCamera(c) {
  const { username, password, ip } = parseRtsp(c.rtsp_url)
  if (!ip) {
    console.log(`[motion] câmera ${c.name}: RTSP sem IP reconhecível, pulando`)
    return
  }
  const entry = {
    cam: null,
    lastEventAt: 0,
    lastAlertAt: 0,
    info: { id: c.id, name: c.name, slug: c.slug },
  }
  const cam = new Cam(
    {
      hostname: ip,
      username,
      password,
      port: c.onvif_port || 8899,
      timeout: 8000,
    },
    (err) => {
      if (err) {
        // falha de conexão: remove do Map e re-tenta no próximo ciclo de 60s
        console.log(`[motion] falha ONVIF câmera ${c.name} (${ip}): ${err.message}`)
        active.delete(c.id)
        return
      }
      try {
        // ao adicionar listener, a lib cria a pullpoint subscription sozinha
        cam.on('event', (msg) => {
          try {
            const topic = msg?.topic?._
            if (!isMotionTopic(topic)) return
            if (!motionValue(msg)) return // só dispara no INÍCIO do movimento (Value=true)
            onMotion(entry).catch((e) =>
              console.error(`[motion] handler (${c.slug}):`, e.message)
            )
          } catch (e) {
            console.error(`[motion] evento (${c.slug}):`, e.message)
          }
        })
        console.log(`[motion] conectou câmera ${c.name} (${ip}:${c.onvif_port || 8899})`)
      } catch (e) {
        console.error(`[motion] subscribe (${c.slug}):`, e.message)
        active.delete(c.id)
      }
    }
  )
  // erros assíncronos (socket caiu etc.): loga, descarta e re-tenta no próximo ciclo
  cam.on('error', (e) => {
    console.log(`[motion] erro ONVIF câmera ${c.name}: ${e?.message || e}`)
    disconnectCamera(c.id)
  })
  entry.cam = cam
  active.set(c.id, entry)
}

// Desconecta: remove listeners e descarta (a lib para o pull sem listener limpo)
function disconnectCamera(id) {
  const entry = active.get(id)
  if (!entry) return
  try {
    entry.cam?.removeAllListeners('event')
    entry.cam?.removeAllListeners('error')
  } catch {
    // ignore
  }
  active.delete(id)
  console.log(`[motion] desconectou câmera ${entry.info.name}`)
}

// Ciclo de sincronização (60s): conecta nas novas, desconecta das removidas
async function syncCameras() {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, slug, rtsp_url, onvif_port FROM cameras WHERE enabled = true AND motion = true'
    )
    const wanted = new Map(rows.map((c) => [c.id, c]))
    // remove as que saíram (desabilitadas / motion=false / deletadas)
    for (const id of [...active.keys()]) {
      if (!wanted.has(id)) disconnectCamera(id)
    }
    // conecta as novas
    for (const c of rows) {
      if (!active.has(c.id)) {
        try {
          connectCamera(c)
        } catch (e) {
          console.error(`[motion] connect (${c.slug}):`, e.message)
        }
      }
    }
  } catch (e) {
    console.error('[motion] sync erro:', e.message)
  }
}

// Limpeza 1x/hora: eventos com mais de 7 dias (banco) + .jpg órfãos (disco)
async function cleanupEvents() {
  try {
    await pool.query(`DELETE FROM events WHERE started_at < now() - interval '7 days'`)
  } catch (e) {
    console.error('[motion] cleanup events (db):', e.message)
  }
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000
    const files = await readdir(EVENTS_DIR)
    for (const f of files) {
      if (!f.endsWith('.jpg')) continue
      try {
        const s = await stat(join(EVENTS_DIR, f))
        if (s.mtimeMs < cutoff) await unlink(join(EVENTS_DIR, f))
      } catch {
        // arquivo sumiu no meio — ignora
      }
    }
  } catch (e) {
    console.error('[motion] cleanup events (fs):', e.message)
  }
}

// Inicia o motor de movimento (idempotente, como startHealthMonitor)
export function startMotionEngine() {
  if (started) return
  started = true
  syncCameras()
  setInterval(syncCameras, 60_000) // sincroniza câmeras a cada 60s
  cleanupEvents()
  setInterval(cleanupEvents, 3_600_000) // limpeza 1x/hora
  console.log('[motion] motor de detecção de movimento iniciado')
}
