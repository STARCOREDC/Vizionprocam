// Proxy de playback com suporte a HTTP Range (206).
// O playback server do Mediamtx (:9996 /get) responde em chunked, SEM
// Content-Length e SEM Accept-Ranges — o AVPlayer do iOS não toca assim
// (fica "Carregando..."). Aqui bufferizamos o trecho e servimos com Range
// real, que é o que o player precisa. Cache curto evita re-gerar o mesmo
// trecho a cada range request do player.
const MEDIAMTX_PLAYBACK = process.env.MEDIAMTX_PLAYBACK || 'http://127.0.0.1:9996'

const cache = new Map() // key -> { buf, ts }
const TTL_MS = 120_000 // 2 min
const MAX_ENTRIES = 12 // ~8MB cada -> teto ~100MB

function getCached(key) {
  const e = cache.get(key)
  if (e && Date.now() - e.ts < TTL_MS) return e.buf
  if (e) cache.delete(key)
  return null
}
function setCached(key, buf) {
  cache.set(key, { buf, ts: Date.now() })
  if (cache.size > MAX_ENTRIES) {
    // remove a entrada mais antiga
    let oldestKey = null
    let oldestTs = Infinity
    for (const [k, v] of cache) if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
    if (oldestKey) cache.delete(oldestKey)
  }
}

export default async function playbackRoutes(app) {
  // GET /get?path=<slug>&start=<ISO>&duration=<seg>&format=mp4
  app.get('/get', async (req, reply) => {
    const { path, start, duration, format } = req.query || {}
    if (!path || !start) return reply.code(400).send()

    const key = `${path}|${start}|${duration}|${format}`
    let buf = getCached(key)
    if (!buf) {
      const url =
        `${MEDIAMTX_PLAYBACK}/get?path=${encodeURIComponent(path)}` +
        `&start=${encodeURIComponent(start)}` +
        `&duration=${encodeURIComponent(duration || 60)}` +
        `&format=${encodeURIComponent(format || 'mp4')}`
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) })
        if (!resp.ok) return reply.code(resp.status).send()
        buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length > 0) setCached(key, buf)
      } catch (e) {
        app.log.error(`[playback] ${e.message}`)
        return reply.code(502).send()
      }
    }

    const total = buf.length
    reply.header('Content-Type', 'video/mp4')
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'no-store')

    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      if (m) {
        let s = parseInt(m[1], 10)
        let e = m[2] ? parseInt(m[2], 10) : total - 1
        if (s >= total) {
          reply.header('Content-Range', `bytes */${total}`)
          return reply.code(416).send()
        }
        if (e >= total) e = total - 1
        reply.code(206)
        reply.header('Content-Range', `bytes ${s}-${e}/${total}`)
        reply.header('Content-Length', String(e - s + 1))
        return reply.send(buf.subarray(s, e + 1))
      }
    }
    reply.header('Content-Length', String(total))
    return reply.send(buf)
  })
}
