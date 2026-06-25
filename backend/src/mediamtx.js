import { pool } from './db.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'

const execFileP = promisify(execFile)
const SNAP_DIR = '/tmp/vizionpro-snaps'
mkdirSync(SNAP_DIR, { recursive: true })

// Mediamtx control API (api: yes em /etc/mediamtx/mediamtx.yml)
const API = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997'
// Servidor de playback de gravações (playback: yes, porta 9996)
const PLAYBACK = process.env.MEDIAMTX_PLAYBACK || 'http://127.0.0.1:9996'
// RTSP local pra onde o transcode publica
const RTSP_LOCAL = process.env.MEDIAMTX_RTSP || 'rtsp://localhost:8554'

// Monta a config de um path no Mediamtx conforme a câmera:
// - transcode=false: pass-through (source direto da câmera)
// - transcode=true : ffmpeg COPIA o vídeo (H.264/H.265 — o app iOS/Android toca
//   nativo) e converte SÓ o áudio p/ AAC. Câmeras XM/iCSee gravam áudio em
//   G.711/PCMA, que o iOS não decodifica dentro do MP4 -> a reprodução da
//   gravação (playback) trava. Normalizar p/ AAC resolve o playback, é leve
//   (não recodifica vídeo) e mantém 1 só conexão na câmera (o ffmpeg lê dela).
// - record: grava em disco com retenção de record_days dias
function pathConfig(rtsp, transcode, record, recordDays) {
  const cfg = {}
  const ffmpegCmd =
    // -stimeout: se a câmera cair, o ffmpeg detecta (5s sem dados), sai, e o
    // Mediamtx reinicia o comando (runOnInitRestart) -> reconecta sozinho ao voltar.
    `ffmpeg -rtsp_transport tcp -stimeout 5000000 -i ${rtsp} ` +
    `-c:v copy ` +
    `-c:a aac -b:a 64k -ac 1 ` +
    `-f rtsp ${RTSP_LOCAL}/$MTX_PATH`
  if (transcode) {
    if (record) {
      // grava 24/7: ffmpeg sempre rodando (runOnInit)
      cfg.runOnInit = ffmpegCmd
      cfg.runOnInitRestart = true
    } else {
      // só ao vivo: ffmpeg sob demanda (economiza CPU)
      cfg.runOnDemand = ffmpegCmd
      cfg.runOnDemandRestart = true
      cfg.runOnDemandCloseAfter = '30s'
    }
  } else {
    cfg.source = rtsp
    // Força RTSP sobre TCP no source. Via CGNAT (NAT da operadora) o UDP não
    // passa, e câmeras baratas (XM/iCSee) recusam quando o mediamtx tenta UDP.
    cfg.rtspTransport = 'tcp'
    // se grava, mantém sempre ligado p/ gravar 24/7; senão, sob demanda
    cfg.sourceOnDemand = !record
  }
  cfg.record = !!record
  if (record) {
    const days = Number(recordDays) > 0 ? Number(recordDays) : 5
    cfg.recordDeleteAfter = `${days * 24}h` // retenção -> rotaciona/sobrescreve
  }
  return cfg
}

// Registra um path arbitrário na API de config do Mediamtx
async function addPath(name, cfg) {
  const res = await fetch(`${API}/v3/config/paths/add/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`mediamtx add ${name}: ${res.status} ${t}`)
  }
}

async function deletePath(name) {
  const res = await fetch(`${API}/v3/config/paths/delete/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 404) throw new Error(`mediamtx del ${name}: ${res.status}`)
}

// Registra a câmera no Mediamtx. Se rtspSd vier preenchido, registra também
// o path secundário `<slug>-sd` (stream SD pra visualização em rede ruim).
// O SD segue a mesma lógica de transcode da câmera, mas NUNCA grava
// (record=false sempre) — gravação fica só no stream principal.
export async function addCameraPath(slug, rtsp, transcode = false, record = false, recordDays = 5, rtspSd = null) {
  await removeCameraPath(slug).catch(() => {})
  await addPath(slug, pathConfig(rtsp, transcode, record, recordDays))
  if (rtspSd) {
    try {
      // record=false -> transcode vira runOnDemand (sob demanda) e
      // pass-through vira sourceOnDemand:true — só visualização, sem gravação.
      await addPath(`${slug}-sd`, pathConfig(rtspSd, transcode, false))
    } catch (e) {
      // SD é opcional: falha aqui não pode derrubar o registro do principal
      console.error(`[mediamtx] add ${slug}-sd:`, e.message)
    }
  }
}

export async function removeCameraPath(slug) {
  // remove também o path secundário SD, se existir
  await deletePath(`${slug}-sd`).catch(() => {})
  await deletePath(slug)
}

export async function syncAllCameras() {
  const { rows } = await pool.query(
    'SELECT slug, rtsp_url, rtsp_url_sd, transcode, record, record_days FROM cameras WHERE enabled = true'
  )
  let ok = 0
  for (const c of rows) {
    try {
      await addCameraPath(c.slug, c.rtsp_url, c.transcode, c.record, c.record_days, c.rtsp_url_sd)
      ok++
    } catch (e) {
      console.error('[mediamtx] sync', c.slug, e.message)
    }
  }
  console.log(`[mediamtx] sincronizadas ${ok}/${rows.length} câmeras`)
}

// Nomes dos paths CONFIGURADOS no mediamtx (não só os ativos). Retorna null
// se o mediamtx estiver fora do ar (pra não disparar resync indevido).
async function getConfiguredPaths() {
  try {
    const res = await fetch(`${API}/v3/config/paths/list`)
    if (!res.ok) return null
    const d = await res.json()
    return new Set((d.items || []).map((p) => p.name))
  } catch {
    return null
  }
}

// Recria no mediamtx só os paths que sumiram (ex: quando o mediamtx reinicia
// sozinho — os paths são adicionados em runtime via API e somem no restart).
// NÃO toca nos que já existem, então não interrompe streams ativos. Chamado
// periodicamente pelo monitor de saúde -> câmera nunca fica "offline" à toa.
export async function syncMissingCameras() {
  const configured = await getConfiguredPaths()
  if (configured === null) return // mediamtx indisponível: não faz nada
  const { rows } = await pool.query(
    'SELECT slug, rtsp_url, rtsp_url_sd, transcode, record, record_days FROM cameras WHERE enabled = true'
  )
  let restored = 0
  for (const c of rows) {
    if (configured.has(c.slug)) continue
    try {
      await addCameraPath(c.slug, c.rtsp_url, c.transcode, c.record, c.record_days, c.rtsp_url_sd)
      restored++
    } catch (e) {
      console.error('[mediamtx] resync', c.slug, e.message)
    }
  }
  if (restored) {
    console.log(`[mediamtx] auto-resync: ${restored} câmera(s) recriada(s) (mediamtx havia reiniciado)`)
  }
}

// Lista gravações de uma câmera via servidor de playback do Mediamtx
export async function listRecordings(slug) {
  try {
    const res = await fetch(`${PLAYBACK}/list?path=${encodeURIComponent(slug)}`)
    if (!res.ok) return []
    const segs = await res.json()
    return (Array.isArray(segs) ? segs : []).map((s) => ({
      name: s.start,
      start: s.start,
      durationSec: Math.round(s.duration || 0),
      url: `/playback/get?path=${encodeURIComponent(slug)}&start=${encodeURIComponent(
        s.start
      )}&duration=${Math.round(s.duration || 0)}&format=mp4`,
    }))
  } catch {
    return []
  }
}

// Retorna um Set com os slugs cujo stream está ativo (ready) no Mediamtx
export async function getOnlinePaths() {
  try {
    const res = await fetch(`${API}/v3/paths/list`)
    if (!res.ok) return new Set()
    const d = await res.json()
    return new Set((d.items || []).filter((p) => p.ready).map((p) => p.name))
  } catch {
    return new Set()
  }
}

// Gera (com cache de ~8s) uma miniatura JPEG da câmera a partir do RTSP local
// do Mediamtx (não onera a câmera). Lança erro se a câmera estiver offline.
// opts.fresh = true ignora o cache (essencial pro Guardião: a foto precisa ser
// do INSTANTE do movimento, senão a IA analisa um frame antigo/vazio).
export async function getSnapshot(slug, opts = {}) {
  const file = `${SNAP_DIR}/${slug}.jpg`
  if (!opts.fresh) {
    try {
      const s = await stat(file)
      if (Date.now() - s.mtimeMs < 8000) return await readFile(file)
    } catch {
      // sem cache ainda
    }
  }
  // -skip_frame nokey: decodifica só keyframes. Em HEVC, pegar 1 frame qualquer
  // costuma cair no meio do GOP e sair CINZA (sem o I-frame de referência);
  // forçar keyframe garante imagem válida (vale p/ miniaturas, eventos, guardião).
  await execFileP(
    'ffmpeg',
    ['-y', '-skip_frame', 'nokey', '-rtsp_transport', 'tcp', '-i', `${RTSP_LOCAL}/${slug}`,
     '-frames:v', '1', '-q:v', '5', '-vf', 'scale=480:-2', file],
    { timeout: 12000 }
  )
  return await readFile(file)
}

// Testa uma URL RTSP (ffprobe) e devolve codec/resolução/fps/áudio.
export async function probeRtsp(rtsp) {
  const { stdout } = await execFileP(
    'ffprobe',
    [
      '-v', 'error', '-rtsp_transport', 'tcp',
      '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate',
      '-of', 'json', rtsp,
    ],
    { timeout: 15000 }
  )
  const d = JSON.parse(stdout || '{}')
  const v = (d.streams || []).find((s) => s.codec_type === 'video')
  const a = (d.streams || []).find((s) => s.codec_type === 'audio')
  let fps = null
  if (v && v.avg_frame_rate && v.avg_frame_rate.includes('/')) {
    const [n, den] = v.avg_frame_rate.split('/').map(Number)
    if (den) fps = Math.round(n / den)
  }
  return {
    ok: !!v,
    codec: v?.codec_name || null,
    width: v?.width || null,
    height: v?.height || null,
    fps,
    hasAudio: !!a,
    suggestTranscode: v?.codec_name === 'hevc' || v?.codec_name === 'h265',
  }
}
