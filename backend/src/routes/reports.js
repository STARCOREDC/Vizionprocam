import os from 'node:os'

import { pool } from '../db.js'
import { getOnlinePaths } from '../mediamtx.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997'

const execFileP = promisify(execFile)

async function dirBytes(dir) {
  try {
    const { stdout } = await execFileP('du', ['-sb', dir], { timeout: 8000 })
    return Number(stdout.split('\t')[0]) || 0
  } catch {
    return 0
  }
}

async function diskInfo(path) {
  try {
    const { stdout } = await execFileP('df', ['-B1', '--output=size,used,avail', path], {
      timeout: 5000,
    })
    const line = stdout.trim().split('\n')[1].trim().split(/\s+/)
    return { size: Number(line[0]), used: Number(line[1]), avail: Number(line[2]) }
  } catch {
    return null
  }
}

export default async function reportRoutes(app) {
  const admin = { preHandler: [app.requireAdmin] }

  app.get('/summary', admin, async () => {
    const num = async (sql) => Number((await pool.query(sql)).rows[0].c)
    const online = await getOnlinePaths()
    const cams = (
      await pool.query('SELECT id, name, slug, enabled, record, record_days FROM cameras ORDER BY name')
    ).rows
    const camerasList = await Promise.all(
      cams.map(async (c) => ({
        ...c,
        online: online.has(c.slug),
        recordingsBytes: await dirBytes(`/opt/vizionpro/recordings/${c.slug}`),
      }))
    )
    const recordingsBytes = await dirBytes('/opt/vizionpro/recordings')
    const disk = await diskInfo('/opt/vizionpro/recordings')

    return {
      cameras: {
        total: cams.length,
        online: camerasList.filter((c) => c.online).length,
        offline: camerasList.filter((c) => !c.online).length,
        recording: cams.filter((c) => c.record).length,
      },
      users: {
        total: await num('SELECT count(*) c FROM users'),
        admins: await num("SELECT count(*) c FROM users WHERE role = 'admin'"),
        viewers: await num("SELECT count(*) c FROM users WHERE role = 'viewer'"),
      },
      groups: await num('SELECT count(*) c FROM groups'),
      alerts: await num('SELECT count(*) c FROM alerts'),
      storage: { recordingsBytes, disk },
      camerasList,
      generatedAt: Date.now(),
    }
  })

  // --- Uptime / disponibilidade por câmera ---
  // Janela: ?days= (default 30, máx 90), limitada à idade da câmera (não
  // penaliza câmera recém-cadastrada). Quedas vêm de camera_outages.
  app.get('/uptime', admin, async (req) => {
    const daysRaw = parseInt(req.query && req.query.days, 10)
    const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 90)

    // created_at pode não existir em bases antigas — fallback sem a coluna
    let cams
    try {
      cams = (
        await pool.query(
          `SELECT id, name, slug, enabled, record,
                  EXTRACT(EPOCH FROM (now() - created_at)) AS age_sec
           FROM cameras ORDER BY name`
        )
      ).rows
    } catch {
      cams = (
        await pool.query(
          'SELECT id, name, slug, enabled, record, NULL AS age_sec FROM cameras ORDER BY name'
        )
      ).rows
    }

    const nowMs = Date.now()
    const monitored = []
    const unmonitored = []

    for (const c of cams) {
      // monitoradas = habilitadas com gravação (são as que o health vigia)
      if (!(c.enabled && c.record)) {
        unmonitored.push({ camera_id: c.id, name: c.name, slug: c.slug, monitored: false })
        continue
      }

      // janela efetiva = min(days, idade da câmera)
      const ageSec = Number(c.age_sec) > 0 ? Number(c.age_sec) : days * 86400
      const windowSec = Math.max(Math.min(days * 86400, ageSec), 1)
      const windowStartMs = nowMs - windowSec * 1000

      let downtimeSec = 0
      let outages = 0
      try {
        // pega quedas que tocam a janela (abertas: ended_at IS NULL conta até agora)
        const { rows } = await pool.query(
          `SELECT started_at, ended_at FROM camera_outages
           WHERE camera_id = $1 AND (ended_at IS NULL OR ended_at > to_timestamp($2))`,
          [c.id, windowStartMs / 1000]
        )
        for (const o of rows) {
          // clampa no início da janela e em "agora" (queda ainda aberta)
          const start = Math.max(new Date(o.started_at).getTime(), windowStartMs)
          const end = o.ended_at ? Math.min(new Date(o.ended_at).getTime(), nowMs) : nowMs
          if (end > start) {
            downtimeSec += (end - start) / 1000
            outages += 1
          }
        }
      } catch (e) {
        app.log.error({ err: e.message }, 'uptime outages')
      }

      downtimeSec = Math.min(Math.round(downtimeSec), windowSec)
      const uptimePct =
        Math.round(Math.min(Math.max(100 * (1 - downtimeSec / windowSec), 0), 100) * 100) / 100

      monitored.push({
        camera_id: c.id,
        name: c.name,
        slug: c.slug,
        monitored: true,
        windowDays: Math.round((windowSec / 86400) * 100) / 100,
        outages,
        downtimeSec,
        uptimePct,
      })
    }

    // piores primeiro (uptime asc); não-monitoradas no fim
    monitored.sort((a, b) => a.uptimePct - b.uptimePct)
    return [...monitored, ...unmonitored]
  })

  // --- Status do sistema (servidor + serviços) ---
  // Nunca lança 500: cada bloco tem try/catch próprio e devolve null em falha.
  app.get('/system', admin, async () => {
    // CPU: load average 1min vs número de núcleos
    let cpu = null
    try {
      const load1 = os.loadavg()[0]
      const cores = os.cpus().length || 1
      cpu = { load1: Math.round(load1 * 100) / 100, cores, loadPct: Math.round((100 * load1) / cores) }
    } catch {
      cpu = null
    }

    // RAM
    let ram = null
    try {
      const total = os.totalmem()
      const free = os.freemem()
      ram = { total, free, used: total - free, usedPct: Math.round((100 * (total - free)) / total) }
    } catch {
      ram = null
    }

    // Discos: raiz e partição de gravações (diskInfo já devolve null em falha)
    const [diskRoot, diskRecordings] = await Promise.all([
      diskInfo('/'),
      diskInfo('/opt/vizionpro/recordings'),
    ])

    // Processos ffmpeg ativos (pgrep sai com código 1 se não achar nada → 0)
    let ffmpegCount = 0
    try {
      const { stdout } = await execFileP('pgrep', ['-c', '-f', 'ffmpeg'], { timeout: 5000 })
      ffmpegCount = parseInt(stdout.trim(), 10) || 0
    } catch {
      ffmpegCount = 0
    }

    // Mediamtx: total de paths e quantos estão prontos (ready)
    let mediamtx = null
    try {
      const res = await fetch(`${MEDIAMTX_API}/v3/paths/list`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const d = await res.json()
      const items = d.items || []
      mediamtx = {
        ok: true,
        pathsTotal: items.length,
        pathsReady: items.filter((p) => p.ready).length,
      }
    } catch {
      mediamtx = { ok: false, pathsTotal: null, pathsReady: null }
    }

    // Banco: latência de um SELECT 1
    let db = null
    try {
      const t0 = Date.now()
      await pool.query('SELECT 1')
      db = { ok: true, pingMs: Date.now() - t0 }
    } catch {
      db = { ok: false, pingMs: null }
    }

    // Uptimes (segundos): servidor (SO) e processo do backend
    let uptimeSec = null
    let serviceUptimeSec = null
    try {
      uptimeSec = Math.round(os.uptime())
      serviceUptimeSec = Math.round(process.uptime())
    } catch {
      // mantém nulls
    }

    return {
      cpu,
      ram,
      disk: { root: diskRoot, recordings: diskRecordings },
      uptimeSec,
      serviceUptimeSec,
      processes: { ffmpeg: ffmpegCount },
      mediamtx,
      db,
      generatedAt: Date.now(),
    }
  })
}
