import { pool } from './db.js'
import { getOnlinePaths, syncMissingCameras } from './mediamtx.js'
import { sendWhatsApp } from './whatsapp.js'
import { sendPushToUsers } from './push.js'
import { ptzGotoHome } from './ptz.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
let diskAlerted = false

// Alerta de disco cheio (só WhatsApp pro provedor — é assunto de operação)
async function checkDisk() {
  try {
    const { stdout } = await execFileP(
      'df',
      ['--output=pcent', '/opt/vizionpro/recordings'],
      { timeout: 5000 }
    )
    const pct = parseInt(stdout.trim().split('\n')[1], 10)
    if (Number.isFinite(pct)) {
      if (pct >= 85 && !diskAlerted) {
        diskAlerted = true
        sendWhatsApp(
          `⚠️ Armazenamento em ${pct}% — disco de gravações quase cheio. Libere espaço ou aumente o disco.`
        ).catch(() => {})
      } else if (pct < 80) {
        diskAlerted = false
      }
    }
  } catch {
    // ignore
  }
}

// Monitor de saúde das câmeras: detecta offline/online e dispara alertas.
const state = new Map() // slug -> { online, misses, lastOfflineAlert }
const OFFLINE_REALERT_MS = 5 * 60 * 1000 // re-avisa a cada 5 min enquanto offline
let started = false

// usuários (viewer) que podem ver a câmera — p/ alerta in-app
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

// extrai host/IP da URL RTSP (sem expor a senha no zap)
function rtspHost(url) {
  try {
    const m = String(url).match(/rtsp:\/\/(?:[^@/]*@)?([^/:]+)(?::(\d+))?/i)
    return m ? m[1] + (m[2] ? `:${m[2]}` : '') : '—'
  } catch {
    return '—'
  }
}

async function fireAlert(cam, online) {
  // Histórico de disponibilidade (uptime): registra início/fim da queda.
  // try/catch isolado — falha aqui NUNCA pode quebrar o alerta em si.
  try {
    if (online) {
      // voltou: fecha a(s) queda(s) em aberto desta câmera
      await pool.query(
        `UPDATE camera_outages SET ended_at = now() WHERE camera_id = $1 AND ended_at IS NULL`,
        [cam.id]
      )
    } else {
      // offline confirmado: abre registro de queda (started_at = default now())
      await pool.query(`INSERT INTO camera_outages (camera_id) VALUES ($1)`, [cam.id])
    }
  } catch (e) {
    console.error('[health] camera_outages:', e.message)
  }

  const title = online ? 'Câmera voltou' : 'Câmera offline'
  const message = online
    ? `A câmera "${cam.name}" voltou a transmitir.`
    : `A câmera "${cam.name}" está offline (sem sinal).`
  const level = online ? 'info' : 'critical'

  // in-app: para cada usuário que enxerga a câmera
  let userNames = []
  try {
    const users = await usersForCamera(cam.id)
    for (const u of users) {
      await pool
        .query(
          `INSERT INTO alerts (title, message, level, target_type, target_id)
           VALUES ($1, $2, $3, 'user', $4)`,
          [title, message, level, u.id]
        )
        .catch(() => {})
    }
    userNames = users.map((u) => u.username)

    // push (ADICIONAL ao in-app) — mesmos usuários e texto, com emoji no título.
    // best-effort: sendPushToUsers nunca lança.
    sendPushToUsers(
      users.map((u) => u.id),
      {
        title: online ? '✅ Câmera voltou' : '🔴 Câmera offline',
        body: message,
        data: { type: 'camera', cameraId: cam.id },
      }
    )
  } catch {
    // ignore
  }

  // WhatsApp pro grupo do provedor — com infos completas da câmera
  const lines = [
    `${online ? '✅' : '🔴'} *${title.toUpperCase()}*`,
    ``,
    `📷 Câmera: *${cam.name}*`,
    `🌐 IP: ${rtspHost(cam.rtsp_url)}`,
  ]
  if (cam.location) lines.push(`📍 Local: ${cam.location}`)
  if (userNames.length) lines.push(`👤 Cliente(s): ${userNames.join(', ')}`)
  lines.push(`🕐 ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`)
  sendWhatsApp(lines.join('\n')).catch(() => {})
}

async function tick() {
  try {
    checkDisk()
    // auto-resync: recria no mediamtx os paths que sumiram (ex: mediamtx
    // reiniciou sozinho). Sem isso a câmera fica "offline" até o backend subir.
    await syncMissingCameras().catch(() => {})
    // monitora câmeras habilitadas e com gravação (always-on) — offline é detectável
    const { rows: cams } = await pool.query(
      'SELECT id, name, slug, rtsp_url, location, onvif_port FROM cameras WHERE enabled = true AND record = true'
    )
    if (!cams.length) return
    const online = await getOnlinePaths()
    for (const c of cams) {
      const isOn = online.has(c.slug)
      const st = state.get(c.slug) || { online: true, misses: 0 }
      if (!isOn) {
        st.misses += 1
        if (st.online && st.misses >= 3) {
          // ~60s confirmando: primeira notificação de offline
          st.online = false
          st.offlineCleared = false
          st.lastOfflineAlert = Date.now()
          await fireAlert(c, false)
        } else if (
          !st.online &&
          Date.now() - (st.lastOfflineAlert || 0) >= OFFLINE_REALERT_MS
        ) {
          // continua offline: lembrete a cada 5 min — SÓ push (não cria novo
          // alerta na tela, pra não acumular vários "offline" da mesma câmera)
          st.lastOfflineAlert = Date.now()
          try {
            const ids = (await usersForCamera(c.id)).map((u) => u.id)
            sendPushToUsers(ids, {
              title: '🔴 Câmera offline',
              body: `A câmera "${c.name}" continua offline (sem sinal).`,
              data: { type: 'camera', cameraId: c.id },
            })
          } catch {
            // ignore
          }
        }
      } else {
        if (!st.online) {
          st.online = true
          await fireAlert(c, true)
          // auto-retorno PTZ: câmeras PT voltam pro padrão de fábrica ao
          // reiniciar — mandamos de volta pro preset "home" salvo. Delay pra
          // o stream/ONVIF estabilizar. Best-effort (sem PTZ/preset: ignora).
          setTimeout(() => {
            ptzGotoHome(c)
              .then((t) => console.log(`[health] ${c.slug}: voltou ao preset home (token ${t})`))
              .catch(() => {})
          }, 10000)
        }
        // RESOLVIDO: a câmera está online -> remove os alertas de "Câmera
        // offline" dela (o problema acabou). Roda 1x por câmera até cair de
        // novo; limpa inclusive alertas órfãos (ex: backend reiniciou e perdeu
        // o estado da queda, deixando o "offline" preso na tela).
        if (!st.offlineCleared) {
          await pool
            .query(
              `DELETE FROM alerts WHERE title = 'Câmera offline' AND message LIKE $1`,
              [`%"${c.name}"%`]
            )
            .catch(() => {})
          st.offlineCleared = true
        }
        st.misses = 0
      }
      state.set(c.slug, st)
    }
  } catch (e) {
    console.error('[health] tick erro:', e.message)
  }
}

// Limpeza automática: todo alerta expira em 24 horas (decisão do dono)
async function cleanupAlerts() {
  try {
    await pool.query(`DELETE FROM alerts WHERE created_at < now() - interval '24 hours'`)
  } catch (e) {
    console.error('[health] cleanup alerts:', e.message)
  }
  // Links de convidado expirados há mais de 1 dia também são removidos
  try {
    await pool.query(`DELETE FROM camera_shares WHERE expires_at < now() - interval '1 day'`)
  } catch (e) {
    console.error('[health] cleanup shares:', e.message)
  }
}

export function startHealthMonitor() {
  if (started) return
  started = true
  setInterval(tick, 20000) // 20s; 3 falhas seguidas (~60s) confirma offline
  cleanupAlerts()
  setInterval(cleanupAlerts, 3600000) // limpeza de alertas 1x/hora
  console.log('[health] monitor de câmeras iniciado')
}
