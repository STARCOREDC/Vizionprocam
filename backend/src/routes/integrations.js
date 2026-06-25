import { getWaConfig, setWaConfig, sendWhatsApp, fetchWaGroups } from '../whatsapp.js'
import { getGeminiConfig, setGeminiConfig, analyzeImage } from '../gemini.js'
import { getReportConfig, setReportConfig, sendReport } from '../report.js'
import { getSnapshot } from '../mediamtx.js'
import { pool } from '../db.js'

// Mascara a API Key do Gemini pro painel: mostra só os últimos 4 dígitos.
function maskApiKey(key) {
  if (!key) return ''
  return '••••' + String(key).slice(-4)
}

export default async function integrationRoutes(app) {
  const admin = { preHandler: [app.requireAdmin] }

  app.get('/whatsapp', admin, async () => {
    const cfg = await getWaConfig()
    return (
      cfg || {
        enabled: false,
        baseUrl: '',
        instance: '',
        apiKey: '',
        target: '',
        targetName: '',
      }
    )
  })

  app.put('/whatsapp', admin, async (req) => {
    const { enabled, baseUrl, instance, apiKey, target, targetName } = req.body || {}
    const cfg = {
      enabled: !!enabled,
      baseUrl: baseUrl || '',
      instance: instance || '',
      apiKey: apiKey || '',
      target: target || '',
      targetName: targetName || '',
    }
    await setWaConfig(cfg)
    return { ok: true }
  })

  app.post('/whatsapp/groups', admin, async (req) => {
    return await fetchWaGroups(req.body || {})
  })

  app.post('/whatsapp/test', admin, async (req) => {
    const text =
      (req.body && req.body.text) ||
      '✅ Teste do VizionPro — integração WhatsApp funcionando!'
    return await sendWhatsApp(text)
  })

  // ===== Gemini (IA de visão do Modo Guardião) =====

  // Retorna a config SEM expor a apiKey inteira (só os últimos 4 mascarados).
  app.get('/gemini', admin, async () => {
    try {
      const cfg = await getGeminiConfig()
      return {
        configured: !!(cfg && cfg.apiKey),
        enabled: !!(cfg && cfg.enabled),
        model: (cfg && cfg.model) || 'gemini-2.0-flash',
        mode: cfg && cfg.mode === 'tudo' ? 'tudo' : 'pessoas',
        apiKeyMasked: cfg ? maskApiKey(cfg.apiKey) : '',
      }
    } catch (e) {
      app.log.error({ err: e.message }, 'gemini get')
      return {
        configured: false,
        enabled: false,
        model: 'gemini-2.0-flash',
        mode: 'pessoas',
        apiKeyMasked: '',
      }
    }
  })

  // Salva a config. Se apiKey vier vazia/ausente, MANTÉM a anterior (não apaga).
  app.put('/gemini', admin, async (req, reply) => {
    const { apiKey, model, enabled, mode } = req.body || {}
    const safeMode = mode === 'tudo' ? 'tudo' : mode === 'pessoas' ? 'pessoas' : null
    if (!safeMode) {
      return reply.code(400).send({ error: "mode inválido (use 'pessoas' ou 'tudo')" })
    }
    try {
      const prev = (await getGeminiConfig()) || {}
      const cfg = {
        // apiKey vazia/ausente -> preserva a anterior
        apiKey: apiKey ? String(apiKey) : prev.apiKey || '',
        model: model || prev.model || 'gemini-2.0-flash',
        enabled: !!enabled,
        mode: safeMode,
      }
      await setGeminiConfig(cfg)
      return { ok: true }
    } catch (e) {
      app.log.error({ err: e.message }, 'gemini put')
      return reply.code(500).send({ error: 'falha ao salvar config do Gemini' })
    }
  })

  // Testa a conexão: tira um snapshot da 1a câmera online e roda a análise.
  // override do body permite testar config ainda não salva (apiKey/model/mode).
  app.post('/gemini/test', admin, async (req) => {
    try {
      const { rows } = await pool.query(
        'SELECT slug FROM cameras WHERE enabled = true ORDER BY name LIMIT 1'
      )
      if (!rows[0]) {
        return { ok: false, error: 'Nenhuma câmera habilitada para testar.' }
      }
      let buf
      try {
        buf = await getSnapshot(rows[0].slug)
      } catch {
        return { ok: false, error: 'Câmera offline — não foi possível capturar imagem.' }
      }
      const { apiKey, model, mode } = req.body || {}
      // monta override apenas com o que veio no body (apiKey aciona o uso do override)
      const override = apiKey ? { apiKey: String(apiKey), model, mode } : undefined
      const r = await analyzeImage(buf, override)
      return r
    } catch (e) {
      app.log.error({ err: e.message }, 'gemini test')
      return { ok: false, error: 'Falha ao testar o Gemini.' }
    }
  })

  // ===== Métricas de uso/custo da IA (ai_usage) =====
  // ?days= (default 7, máx 90). Custo estimado ~ US$ 0.0002 por análise.
  const COST_PER_CALL_USD = 0.0002
  app.get('/ai-usage', admin, async (req) => {
    const daysRaw = parseInt(req.query && req.query.days, 10)
    const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 7, 1), 90)
    try {
      // total hoje
      const totalToday = Number(
        (
          await pool.query(
            `SELECT count(*)::int AS c FROM ai_usage WHERE created_at::date = now()::date`
          )
        ).rows[0].c
      )
      // total no período
      const totalPeriod = Number(
        (
          await pool.query(
            `SELECT count(*)::int AS c FROM ai_usage
             WHERE created_at >= now() - make_interval(days => $1)`,
            [days]
          )
        ).rows[0].c
      )
      // por dia (date asc)
      const byDay = (
        await pool.query(
          `SELECT created_at::date AS date, count(*)::int AS count
           FROM ai_usage
           WHERE created_at >= now() - make_interval(days => $1)
           GROUP BY created_at::date
           ORDER BY date`,
          [days]
        )
      ).rows.map((r) => ({
        date:
          r.date instanceof Date
            ? r.date.toISOString().slice(0, 10)
            : String(r.date).slice(0, 10),
        count: Number(r.count),
      }))
      // por câmera (join pra trazer o nome; câmera deletada vira 'removida')
      const byCamera = (
        await pool.query(
          `SELECT u.camera_id, COALESCE(c.name, 'câmera removida') AS name, count(*)::int AS count
           FROM ai_usage u
           LEFT JOIN cameras c ON c.id = u.camera_id
           WHERE u.created_at >= now() - make_interval(days => $1)
           GROUP BY u.camera_id, c.name
           ORDER BY count DESC`,
          [days]
        )
      ).rows.map((r) => ({ camera_id: r.camera_id, name: r.name, count: Number(r.count) }))

      return {
        days,
        totalToday,
        totalPeriod,
        byDay,
        byCamera,
        estimatedCostUsd: Math.round(totalPeriod * COST_PER_CALL_USD * 10000) / 10000,
      }
    } catch (e) {
      app.log.error({ err: e.message }, 'ai-usage')
      return {
        days,
        totalToday: 0,
        totalPeriod: 0,
        byDay: [],
        byCamera: [],
        estimatedCostUsd: 0,
      }
    }
  })

  // ===== Relatório inteligente automático (resumo periódico no WhatsApp) =====

  // Valida HH:MM (00:00 a 23:59).
  const isValidTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''))

  // Config atual { enabled, frequency, time, target, useAI } + last_sent (se houver).
  app.get('/report', admin, async () => {
    try {
      const cfg = await getReportConfig()
      return {
        enabled: !!cfg.enabled,
        frequency: cfg.frequency === 'daily' ? 'daily' : 'weekly',
        time: cfg.time || '08:00',
        target: cfg.target || '',
        useAI: !!cfg.useAI,
        last_sent: cfg.last_sent || null,
      }
    } catch (e) {
      app.log.error({ err: e.message }, 'report get')
      return {
        enabled: false,
        frequency: 'weekly',
        time: '08:00',
        target: '',
        useAI: false,
        last_sent: null,
      }
    }
  })

  // Salva a config. Valida frequency e formato do horário.
  app.put('/report', admin, async (req, reply) => {
    const { enabled, frequency, time, target, useAI } = req.body || {}
    if (frequency !== 'daily' && frequency !== 'weekly') {
      return reply.code(400).send({ error: "frequency inválido (use 'daily' ou 'weekly')" })
    }
    if (!isValidTime(time)) {
      return reply.code(400).send({ error: 'time inválido (use o formato HH:MM, ex 08:00)' })
    }
    try {
      await setReportConfig({
        enabled: !!enabled,
        frequency,
        time,
        target: target || '',
        useAI: !!useAI,
      })
      return { ok: true }
    } catch (e) {
      app.log.error({ err: e.message }, 'report put')
      return reply.code(500).send({ error: 'falha ao salvar config do relatório' })
    }
  })

  // Gera e ENVIA um relatório AGORA (botão "Enviar teste" do painel).
  // Usa o período da frequência atual (daily=1, weekly=7; default 7).
  app.post('/report/test', admin, async () => {
    try {
      const cfg = await getReportConfig()
      const periodDays = cfg.frequency === 'daily' ? 1 : 7
      const periodLabel = cfg.frequency === 'daily' ? 'do dia' : 'da semana'
      const r = await sendReport(periodDays, periodLabel)
      // sendReport sempre devolve { ok, sent, preview, error? }
      return { ok: !!r.ok, sent: !!r.sent, preview: r.preview || '', error: r.error }
    } catch (e) {
      app.log.error({ err: e.message }, 'report test')
      return { ok: false, sent: false, preview: '', error: 'Falha ao gerar/enviar o relatório.' }
    }
  })
}
