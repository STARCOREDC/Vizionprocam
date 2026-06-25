import { createReadStream } from 'node:fs'
import { randomBytes } from 'node:crypto'

import { pool } from '../db.js'
import {
  addCameraPath,
  removeCameraPath,
  listRecordings,
  getOnlinePaths,
  getSnapshot,
  probeRtsp,
} from '../mediamtx.js'
import { onvifDetect, talkCapability } from '../onvif-detect.js'
import { ptzMove, ptzStop, ptzSetHome, ptzGotoHome } from '../ptz.js'
import { parseRtsp } from '../motion.js'
import { startTimelapse, timelapseStatus, timelapseVideo } from '../timelapse.js'

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// O usuário pode acessar a câmera? admin sempre; viewer se a câmera está
// nos seus grupos ou foi atribuída diretamente (mesma regra de recordings).
async function canAccessCamera(user, cameraId) {
  if (user.role === 'admin') return true
  const perm = await pool.query(
    `SELECT 1 FROM cameras c WHERE c.id = $2 AND (
       c.id IN (SELECT camera_id FROM user_cameras WHERE user_id = $1)
       OR c.id IN (
         SELECT cg.camera_id FROM camera_groups cg
         JOIN user_groups ug ON ug.group_id = cg.group_id WHERE ug.user_id = $1)
     ) LIMIT 1`,
    [user.id, cameraId]
  )
  return !!perm.rows[0]
}

export default async function cameraRoutes(app) {
  const auth = { preHandler: [app.authenticate] }
  const admin = { preHandler: [app.requireAdmin] }

  // Testa uma URL RTSP (ffprobe) — valida e mostra codec/resolução/áudio
  app.post('/test-rtsp', admin, async (req, reply) => {
    const { rtsp_url } = req.body || {}
    if (!rtsp_url) return reply.code(400).send({ error: 'rtsp_url obrigatório' })
    try {
      return await probeRtsp(rtsp_url)
    } catch {
      return reply.send({ ok: false, error: 'Não foi possível conectar ou ler o RTSP.' })
    }
  })

  // Auto-detecta a URL RTSP via ONVIF (IP + usuário + senha)
  app.post('/onvif-detect', admin, async (req, reply) => {
    const { ip, port, username, password } = req.body || {}
    if (!ip) return reply.code(400).send({ error: 'IP obrigatório' })
    try {
      return await onvifDetect({ ip, port, username, password })
    } catch (e) {
      return reply.send({ ok: false, error: e.message || 'falha ao consultar ONVIF' })
    }
  })

  // Lista câmeras conforme permissão:
  // admin -> todas; viewer -> câmeras dos seus grupos + câmeras avulsas (só habilitadas)
  app.get('/', auth, async (req) => {
    let rows
    if (req.user.role === 'admin') {
      rows = (
        await pool.query(
          `SELECT id, name, slug, location, enabled, transcode, record,
                  guardian, guardian_sensitivity, guardian_focus, guardian_schedule,
                  tamper_detect, ai_daily_limit,
                  face_recognition, audio_detect, audio_threshold_db,
                  (rtsp_url_sd IS NOT NULL) AS has_sd
           FROM cameras ORDER BY name`
        )
      ).rows
    } else {
      rows = (
        await pool.query(
          `SELECT DISTINCT c.id, c.name, c.slug, c.location, c.enabled,
                  c.guardian, c.guardian_sensitivity, c.guardian_focus, c.guardian_schedule,
                  c.face_recognition, c.audio_detect, c.audio_threshold_db,
                  (c.rtsp_url_sd IS NOT NULL) AS has_sd
           FROM cameras c
           WHERE c.enabled = true AND (
             c.id IN (SELECT camera_id FROM user_cameras WHERE user_id = $1)
             OR c.id IN (
               SELECT cg.camera_id FROM camera_groups cg
               JOIN user_groups ug ON ug.group_id = cg.group_id
               WHERE ug.user_id = $1
             )
           )
           ORDER BY name`,
          [req.user.id]
        )
      ).rows
    }
    // enriquece com status online (Mediamtx) e favoritos do usuário
    const [online, favRows] = await Promise.all([
      getOnlinePaths(),
      pool.query('SELECT camera_id FROM user_favorites WHERE user_id = $1', [req.user.id]),
    ])
    const favs = new Set(favRows.rows.map((r) => r.camera_id))
    return rows.map((c) => ({ ...c, online: online.has(c.slug), favorite: favs.has(c.id) }))
  })

  // Snapshot (miniatura ao vivo) — JPEG, cache ~8s
  app.get('/:id/snapshot', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT slug FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    try {
      const buf = await getSnapshot(rows[0].slug)
      return reply.header('Cache-Control', 'no-cache').type('image/jpeg').send(buf)
    } catch {
      return reply.code(503).send({ error: 'offline' })
    }
  })

  // Favoritar/desfavoritar (por usuário)
  app.put('/:id/favorite', auth, async (req) => {
    const fav = !!(req.body && req.body.favorite)
    if (fav) {
      await pool.query(
        'INSERT INTO user_favorites (user_id, camera_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.user.id, req.params.id]
      )
    } else {
      await pool.query('DELETE FROM user_favorites WHERE user_id = $1 AND camera_id = $2', [
        req.user.id,
        req.params.id,
      ])
    }
    return { ok: true, favorite: fav }
  })

  // Modo Guardião (ligar/desligar + sensibilidade) — por câmera.
  // VIEWER PODE: é a câmera dele. Mesma checagem de permissão de /:id/recordings.
  app.put('/:id/guardian', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT id FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const enabled = !!(req.body && req.body.enabled)
    // sensibilidade opcional; valida contra os níveis aceitos (senão mantém a atual)
    let sensitivity = req.body && req.body.sensitivity
    if (!['alta', 'media', 'baixa'].includes(sensitivity)) sensitivity = null
    const upd = await pool.query(
      `UPDATE cameras
       SET guardian = $1, guardian_sensitivity = COALESCE($2, guardian_sensitivity)
       WHERE id = $3
       RETURNING guardian, guardian_sensitivity`,
      [enabled, sensitivity, req.params.id]
    )
    const c = upd.rows[0]
    return { ok: true, guardian: c.guardian, sensitivity: c.guardian_sensitivity }
  })

  // Foco de detecção da câmera (o que a IA do Guardião procura) — VIEWER PODE.
  // Retorna o foco atual + a lista de presets disponíveis (pro seletor).
  app.get('/:id/guardian-focus', auth, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT guardian_focus, guardian_focus_custom FROM cameras WHERE id = $1',
      [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    let presets = []
    try {
      presets = (
        await pool.query('SELECT key, name, emoji FROM detection_presets ORDER BY builtin DESC, name')
      ).rows
    } catch (e) {
      app.log.error({ err: e.message }, 'guardian-focus presets')
    }
    return {
      focus: rows[0].guardian_focus || 'pessoas',
      custom: rows[0].guardian_focus_custom || '',
      presets,
    }
  })

  // Define o foco de detecção da câmera — VIEWER PODE.
  // body { focus, custom? }: focus deve existir em detection_presets OU =='custom'
  // (custom exige texto não-vazio em custom).
  app.put('/:id/guardian-focus', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT id FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    // focus aceita string ("pessoas") OU array (["pessoas","fogo"]) -> multi-seleção.
    let focus = req.body && req.body.focus
    const custom = (req.body && req.body.custom) || ''
    if (Array.isArray(focus)) focus = focus.map((f) => String(f).trim()).filter(Boolean)
    else if (typeof focus === 'string') focus = focus.split(',').map((f) => f.trim()).filter(Boolean)
    else focus = []
    if (!focus.length) return reply.code(400).send({ error: 'focus obrigatório' })

    // valida cada key: 'custom' (exige texto) ou existir em detection_presets
    if (focus.includes('custom') && !String(custom).trim()) {
      return reply.code(400).send({ error: 'custom exige um texto de instrução' })
    }
    const presetKeys = focus.filter((f) => f !== 'custom')
    if (presetKeys.length) {
      const v = await pool.query('SELECT key FROM detection_presets WHERE key = ANY($1)', [presetKeys])
      const validos = new Set(v.rows.map((r) => r.key))
      const invalido = presetKeys.find((k) => !validos.has(k))
      if (invalido) return reply.code(400).send({ error: `foco inexistente: ${invalido}` })
    }

    const focusStr = focus.join(',') // guardado como CSV em guardian_focus (text)
    const upd = await pool.query(
      `UPDATE cameras
       SET guardian_focus = $1,
           guardian_focus_custom = $2
       WHERE id = $3
       RETURNING guardian_focus, guardian_focus_custom`,
      [focusStr, focus.includes('custom') ? String(custom).trim() : null, req.params.id]
    )
    return { ok: true, focus: upd.rows[0].guardian_focus, custom: upd.rows[0].guardian_focus_custom || '' }
  })

  // Agendamento do Guardião (cliente/viewer pode definir o da sua câmera).
  app.put('/:id/guardian-schedule', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT id FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const s = (req.body && req.body.schedule) || {}
    // valida/normaliza: enabled bool, days array 0-6, start/end "HH:MM"
    const hhmm = (v) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : null)
    const schedule = {
      enabled: !!s.enabled,
      days: Array.isArray(s.days) ? s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
      start: hhmm(s.start) || '22:00',
      end: hhmm(s.end) || '06:00',
    }
    await pool.query('UPDATE cameras SET guardian_schedule = $1 WHERE id = $2', [
      JSON.stringify(schedule),
      req.params.id,
    ])
    return { ok: true, schedule }
  })

  // Detecção de ÁUDIO (#2) — liga/desliga + limiar (dB). VIEWER PODE.
  // body { enabled, threshold? }. threshold válido entre -60 e 0 (dB).
  // Quando threshold ausente/inválido, mantém o atual (COALESCE).
  app.put('/:id/audio-detect', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT id FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const enabled = !!(req.body && req.body.enabled)
    // threshold opcional; só aceita números entre -60 e 0 (senão mantém o atual)
    let threshold = req.body && req.body.threshold
    const t = Number(threshold)
    threshold = Number.isFinite(t) && t >= -60 && t <= 0 ? Math.round(t) : null
    const upd = await pool.query(
      `UPDATE cameras
       SET audio_detect = $1,
           audio_threshold_db = COALESCE($2, audio_threshold_db)
       WHERE id = $3
       RETURNING audio_detect, audio_threshold_db`,
      [enabled, threshold, req.params.id]
    )
    const c = upd.rows[0]
    return { ok: true, enabled: c.audio_detect, threshold: c.audio_threshold_db }
  })

  // Reconhecimento de MORADORES (#3) — liga/desliga por câmera. VIEWER PODE.
  // body { enabled }.
  app.put('/:id/face-recognition', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT id FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const enabled = !!(req.body && req.body.enabled)
    const upd = await pool.query(
      `UPDATE cameras SET face_recognition = $1 WHERE id = $2 RETURNING face_recognition`,
      [enabled, req.params.id]
    )
    return { ok: true, enabled: upd.rows[0].face_recognition }
  })

  app.get('/:id', admin, async (req, reply) => {
    const { rows } = await pool.query('SELECT * FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    return rows[0]
  })

  app.get('/:id/recordings', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT slug FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    // viewer só lista gravações de câmera que tem permissão
    if (req.user.role !== 'admin') {
      const perm = await pool.query(
        `SELECT 1 FROM cameras c WHERE c.id = $2 AND (
           c.id IN (SELECT camera_id FROM user_cameras WHERE user_id = $1)
           OR c.id IN (
             SELECT cg.camera_id FROM camera_groups cg
             JOIN user_groups ug ON ug.group_id = cg.group_id WHERE ug.user_id = $1)
         ) LIMIT 1`,
        [req.user.id, req.params.id]
      )
      if (!perm.rows[0]) return reply.code(403).send({ error: 'sem permissão' })
    }
    return await listRecordings(rows[0].slug)
  })

  // Dias (YYYY-MM-DD) que têm gravação — pro calendário do DVR
  app.get('/:id/recording-days', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT slug FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (req.user.role !== 'admin') {
      const perm = await pool.query(
        `SELECT 1 FROM cameras c WHERE c.id = $2 AND (
           c.id IN (SELECT camera_id FROM user_cameras WHERE user_id = $1)
           OR c.id IN (
             SELECT cg.camera_id FROM camera_groups cg
             JOIN user_groups ug ON ug.group_id = cg.group_id WHERE ug.user_id = $1)
         ) LIMIT 1`,
        [req.user.id, req.params.id]
      )
      if (!perm.rows[0]) return reply.code(403).send({ error: 'sem permissão' })
    }
    const segs = await listRecordings(rows[0].slug)
    const days = new Set()
    for (const s of segs) {
      const start = new Date(s.start)
      const end = new Date(start.getTime() + (s.durationSec || 0) * 1000)
      // marca todos os dias que o segmento cobre (em hora local do servidor)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const p = (n) => String(n).padStart(2, '0')
        days.add(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
      }
    }
    return { days: [...days].sort() }
  })

  // valida o parâmetro de horas do timelapse (aceita 6, 12 ou 24; default 24)
  function timelapseHours(v) {
    const h = Number(v)
    return [6, 12, 24].includes(h) ? h : 24
  }

  // Timelapse "Resumo do dia": inicia a geração do MP4 acelerado das últimas
  // N horas (cache de 60 min; 1 job por vez no servidor inteiro).
  app.post('/:id/timelapse', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT slug FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const hours = timelapseHours(req.body && req.body.hours)
    try {
      const status = await startTimelapse(rows[0].slug, hours) // 'ready'|'running'|'busy'
      return { status, hours }
    } catch (e) {
      app.log.error({ err: e.message }, 'timelapse start')
      return { status: 'error', hours }
    }
  })

  // Status do timelapse: none | running | ready | error (+ url quando pronto)
  app.get('/:id/timelapse', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT slug FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const hours = timelapseHours(req.query && req.query.hours)
    try {
      const status = await timelapseStatus(rows[0].slug, hours)
      const out = { status, hours }
      if (status === 'ready') {
        out.url = `/api/cameras/${req.params.id}/timelapse/video?hours=${hours}`
      }
      return out
    } catch (e) {
      app.log.error({ err: e.message }, 'timelapse status')
      return { status: 'error', hours }
    }
  })

  // Serve o MP4 do timelapse (stream do arquivo em disco)
  app.get('/:id/timelapse/video', auth, async (req, reply) => {
    const { rows } = await pool.query('SELECT slug FROM cameras WHERE id = $1', [req.params.id])
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const hours = timelapseHours(req.query && req.query.hours)
    try {
      const video = await timelapseVideo(rows[0].slug, hours)
      if (!video) return reply.code(404).send({ error: 'timelapse não gerado' })
      return reply
        .header('Content-Length', video.size)
        .header('Cache-Control', 'no-cache')
        .type('video/mp4')
        .send(createReadStream(video.path))
    } catch (e) {
      app.log.error({ err: e.message }, 'timelapse video')
      return reply.code(404).send({ error: 'timelapse não disponível' })
    }
  })

  // Acesso convidado temporário: gera link público com validade (1 a 72h).
  // Viewer também pode compartilhar — desde que tenha permissão na câmera.
  app.post('/:id/share', auth, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT id FROM cameras WHERE id = $1 AND enabled = true',
      [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    // horas: 1 a 72, default 4
    const h = Number(req.body && req.body.hours)
    const hours = Number.isFinite(h) ? Math.min(Math.max(Math.trunc(h), 1), 72) : 4
    const token = randomBytes(16).toString('hex')
    try {
      const ins = await pool.query(
        `INSERT INTO camera_shares (camera_id, created_by, token, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4))
         RETURNING expires_at`,
        [req.params.id, req.user.id, token, hours]
      )
      return reply.code(201).send({
        token,
        url: `/guest/${token}`,
        expires_at: ins.rows[0].expires_at,
      })
    } catch (e) {
      app.log.error({ err: e.message }, 'camera share')
      return reply.code(500).send({ error: 'falha ao gerar link de convidado' })
    }
  })

  // Checa via ONVIF se a câmera suporta áudio bidirecional (talk).
  // Nunca responde 500: qualquer falha vira { supported: false, reason }.
  // OBS: a transmissão de voz em si será implementada quando houver uma
  // câmera compatível disponível pra teste — por ora só a checagem.
  app.get('/:id/talk-capability', auth, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT rtsp_url, onvif_port FROM cameras WHERE id = $1',
      [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'sem permissão' })
    }
    const unsupported = {
      supported: false,
      reason: 'A câmera não expõe áudio bidirecional (ONVIF).',
    }
    try {
      const { username, password, ip } = parseRtsp(rows[0].rtsp_url)
      if (!ip) return unsupported
      return await talkCapability({
        ip,
        port: rows[0].onvif_port || 8899,
        username,
        password,
      })
    } catch {
      return unsupported
    }
  })

  app.post('/', admin, async (req, reply) => {
    const {
      name, rtsp_url, rtsp_url_sd, location, transcode, record, record_days, motion, onvif_port,
    } = req.body || {}
    if (!name || !rtsp_url) {
      return reply.code(400).send({ error: 'name e rtsp_url obrigatórios' })
    }
    const slug = slugify(name)
    const days = Number(record_days) > 0 ? Number(record_days) : 5
    const onvifPort = Number(onvif_port) > 0 ? Number(onvif_port) : null
    const rtspSd = rtsp_url_sd || null
    try {
      const { rows } = await pool.query(
        `INSERT INTO cameras (name, slug, rtsp_url, rtsp_url_sd, location, transcode, record, record_days, motion, onvif_port)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, name, slug, rtsp_url_sd, location, enabled, transcode, record, record_days, motion, onvif_port`,
        [name, slug, rtsp_url, rtspSd, location || null, !!transcode, !!record, days, !!motion, onvifPort]
      )
      await addCameraPath(slug, rtsp_url, !!transcode, !!record, days, rtspSd).catch((e) =>
        app.log.error({ err: e.message }, 'mediamtx add')
      )
      return reply.code(201).send(rows[0])
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'câmera já existe (nome/slug)' })
      throw e
    }
  })

  app.patch('/:id', admin, async (req, reply) => {
    const allowed = [
      'name', 'rtsp_url', 'rtsp_url_sd', 'location', 'enabled', 'transcode', 'record',
      'record_days', 'motion', 'onvif_port', 'guardian', 'guardian_sensitivity',
      'guardian_focus', 'tamper_detect', 'ai_daily_limit', 'guardian_schedule',
      'face_recognition', 'audio_detect', 'audio_threshold_db',
    ]
    const sets = []
    const vals = []
    for (const f of allowed) {
      if (req.body && f in req.body) {
        sets.push(`${f} = $${sets.length + 1}`)
        vals.push(req.body[f])
      }
    }
    if (!sets.length) return reply.code(400).send({ error: 'nada para atualizar' })
    vals.push(req.params.id)
    const { rows } = await pool.query(
      `UPDATE cameras SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    )
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' })
    const c = rows[0]
    // re-sincroniza com o Mediamtx
    if (c.enabled) {
      await addCameraPath(c.slug, c.rtsp_url, c.transcode, c.record, c.record_days, c.rtsp_url_sd).catch((e) =>
        app.log.error({ err: e.message }, 'mediamtx patch')
      )
    } else {
      await removeCameraPath(c.slug).catch(() => {})
    }
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      location: c.location,
      enabled: c.enabled,
      transcode: c.transcode,
      record: c.record,
      record_days: c.record_days,
      motion: c.motion,
      onvif_port: c.onvif_port,
      guardian: c.guardian,
      guardian_sensitivity: c.guardian_sensitivity,
      guardian_focus: c.guardian_focus,
      guardian_schedule: c.guardian_schedule,
      tamper_detect: c.tamper_detect,
      ai_daily_limit: c.ai_daily_limit,
      face_recognition: c.face_recognition,
      audio_detect: c.audio_detect,
      audio_threshold_db: c.audio_threshold_db,
      rtsp_url_sd: c.rtsp_url_sd,
    }
  })

  app.delete('/:id', admin, async (req) => {
    const { rows } = await pool.query('DELETE FROM cameras WHERE id = $1 RETURNING slug', [
      req.params.id,
    ])
    if (rows[0]) await removeCameraPath(rows[0].slug).catch(() => {})
    return { ok: true }
  })

  // PTZ (mover a câmera + presets) via ONVIF. Requer a porta ONVIF
  // (onvif_port ou 8899) acessível — em CGNAT, port-forward/DMZ no roteador.
  // body: { action: 'move'|'stop'|'set_home'|'goto_home', dir?, speed? }
  app.post('/:id/ptz', auth, async (req, reply) => {
    if (!(await canAccessCamera(req.user, req.params.id))) {
      return reply.code(403).send({ error: 'Sem acesso a esta câmera' })
    }
    const { action, dir } = req.body || {}
    const { rows } = await pool.query(
      'SELECT rtsp_url, onvif_port FROM cameras WHERE id = $1',
      [req.params.id]
    )
    const c = rows[0]
    if (!c) return reply.code(404).send()

    try {
      if (action === 'move') await ptzMove(c, dir)
      else if (action === 'stop') await ptzStop(c)
      else if (action === 'set_home') await ptzSetHome(c)
      else if (action === 'goto_home') await ptzGotoHome(c)
      else return reply.code(400).send({ error: 'Ação inválida' })
      return { ok: true }
    } catch (e) {
      const msg = String(e.message || '')
      // falha de conexão -> dica da porta ONVIF; senão erro genérico do comando
      if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout|connect|socket/i.test(msg)) {
        return reply.code(502).send({
          error: 'Não foi possível conectar no PTZ. Verifique se a porta ONVIF (8899) está liberada no roteador.',
        })
      }
      return reply.code(500).send({ error: msg || 'Falha no comando PTZ' })
    }
  })
}
