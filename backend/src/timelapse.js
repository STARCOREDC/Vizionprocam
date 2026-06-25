// Timelapse "Resumo do dia": gera um MP4 acelerado (~60s) das últimas N horas
// de uma câmera a partir do playback do Mediamtx (porta 9996), usando só os
// keyframes (decodificação leve). Um job por vez no servidor inteiro, com
// cache de 60 min por (câmera, horas) e limpeza automática após 24h.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { stat, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { listRecordings } from './mediamtx.js'

const DIR = '/opt/vizionpro/timelapse'
const PLAYBACK = process.env.MEDIAMTX_PLAYBACK || 'http://127.0.0.1:9996'
const CACHE_FRESH_MS = 60 * 60 * 1000 // cache vale por 60 min
const JOB_TIMEOUT_MS = 15 * 60 * 1000 // mata o ffmpeg após 15 min
const TARGET_FRAMES = 1800 // ~60s de vídeo a 30fps

try {
  mkdirSync(DIR, { recursive: true })
} catch {
  // diretório já existe ou sem permissão — erros aparecem na geração
}

// Estado global: 1 job por vez no servidor (timelapse é pesado em I/O+CPU)
let currentJob = null // chave `${slug}-${hours}h` do job rodando, ou null
const lastErrors = new Set() // chaves cujo último job falhou

const keyOf = (slug, hours) => `${slug}-${hours}h`
const videoPath = (slug, hours) => join(DIR, `${keyOf(slug, hours)}.mp4`)
const metaPath = (slug, hours) => join(DIR, `${keyOf(slug, hours)}.json`)

async function readMeta(slug, hours) {
  try {
    return JSON.parse(await readFile(metaPath(slug, hours), 'utf8'))
  } catch {
    return null
  }
}

async function fileExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// Cache fresco = mp4 existe E metadado gerado há menos de 60 min
async function isCacheFresh(slug, hours) {
  if (!(await fileExists(videoPath(slug, hours)))) return false
  const meta = await readMeta(slug, hours)
  const t = meta?.generatedAt ? new Date(meta.generatedAt).getTime() : 0
  return Number.isFinite(t) && Date.now() - t < CACHE_FRESH_MS
}

// Status atual: 'running' | 'ready' | 'error' | 'none'
export async function timelapseStatus(slug, hours) {
  const key = keyOf(slug, hours)
  if (currentJob === key) return 'running'
  if (await fileExists(videoPath(slug, hours))) return 'ready' // mesmo "velho" continua servível
  if (lastErrors.has(key)) return 'error'
  return 'none'
}

// Caminho + tamanho do mp4 pronto (ou null se não existe) — pra rota de vídeo
export async function timelapseVideo(slug, hours) {
  const p = videoPath(slug, hours)
  try {
    const s = await stat(p)
    return { path: p, size: s.size }
  } catch {
    return null
  }
}

// Inicia (ou reaproveita) a geração. Retorna 'ready' | 'running' | 'busy'.
export async function startTimelapse(slug, hours) {
  const key = keyOf(slug, hours)
  if (await isCacheFresh(slug, hours)) return 'ready'
  if (currentJob === key) return 'running'
  if (currentJob) return 'busy' // outro job em andamento — 1 por vez
  currentJob = key
  lastErrors.delete(key)
  runJob(slug, hours, key) // dispara em background, não aguarda
  return 'running'
}

async function runJob(slug, hours, key) {
  // O playback do Mediamtx retorna 404 se o "start" cair num buraco sem
  // gravação. Por isso alinhamos o início ao primeiro segmento gravado
  // dentro da janela pedida.
  const windowStartMs = Date.now() - hours * 3600 * 1000
  let startMs = null
  try {
    const segs = await listRecordings(slug) // [{start, durationSec}] ordenados
    for (const s of segs) {
      const sStart = new Date(s.start).getTime()
      const sEnd = sStart + (s.durationSec || 0) * 1000
      if (sEnd > windowStartMs) {
        startMs = Math.max(windowStartMs, sStart + 1000)
        break
      }
    }
  } catch {
    // segue com null -> erro abaixo
  }
  if (!startMs) {
    console.error(`[timelapse] ${key}: sem gravações na janela`)
    lastErrors.add(key)
    currentJob = null
    return
  }
  const durationSec = Math.max(60, Math.floor((Date.now() - startMs) / 1000))
  const start = new Date(startMs).toISOString()
  const playbackUrl =
    `${PLAYBACK}/get?path=${encodeURIComponent(slug)}` +
    `&start=${encodeURIComponent(start)}&duration=${durationSec}&format=mp4`
  // Keyframes ~a cada 2s -> seleciona 1 a cada K pra fechar em ~1800 frames (~60s @30fps)
  const K = Math.max(1, Math.round(durationSec / 2 / TARGET_FRAMES))
  const tmp = join(DIR, `.${key}.tmp.mp4`)
  const args = [
    '-y',
    '-skip_frame', 'nokey', // decodifica só keyframes (leve)
    '-i', playbackUrl,
    '-an', // sem áudio
    '-vf', `select=not(mod(n\\,${K})),setpts=N/(30*TB)`,
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    tmp,
  ]

  let finished = false
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] })

  // Timeout de segurança: mata o ffmpeg se passar de 15 min
  const killer = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      // já morreu
    }
  }, JOB_TIMEOUT_MS)

  const fail = async (why) => {
    if (finished) return
    finished = true
    clearTimeout(killer)
    console.error(`[timelapse] job ${key} falhou: ${why}`)
    lastErrors.add(key)
    await unlink(tmp).catch(() => {})
    currentJob = null
  }

  proc.on('error', (e) => {
    // ex.: ffmpeg não encontrado — nunca pode derrubar o server
    fail(e.message).catch(() => {})
  })

  proc.on('close', async (code) => {
    if (finished) return
    if (code !== 0) {
      await fail(`ffmpeg saiu com código ${code}`)
      return
    }
    try {
      finished = true
      clearTimeout(killer)
      await rename(tmp, videoPath(slug, hours))
      await writeFile(
        metaPath(slug, hours),
        JSON.stringify({ generatedAt: new Date().toISOString() })
      )
      console.log(`[timelapse] gerado ${key}.mp4`)
    } catch (e) {
      console.error(`[timelapse] finalização ${key}:`, e.message)
      lastErrors.add(key)
      await unlink(tmp).catch(() => {})
    } finally {
      currentJob = null
    }
  })
}

// Limpeza: apaga timelapses (mp4/json/tmp) com mais de 24h
async function cleanupTimelapses() {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000
    const files = await readdir(DIR)
    for (const f of files) {
      if (!f.endsWith('.mp4') && !f.endsWith('.json')) continue
      try {
        const s = await stat(join(DIR, f))
        if (s.mtimeMs < cutoff) await unlink(join(DIR, f))
      } catch {
        // arquivo sumiu no meio — ignora
      }
    }
  } catch (e) {
    console.error('[timelapse] cleanup:', e.message)
  }
}

// Limpeza 1x/hora — auto-inicia quando o módulo é carregado (idempotente)
let cleanupStarted = false
function startCleanup() {
  if (cleanupStarted) return
  cleanupStarted = true
  cleanupTimelapses()
  setInterval(cleanupTimelapses, 3_600_000)
}
startCleanup()
