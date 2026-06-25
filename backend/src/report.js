// ============================================================================
// RELATÓRIO INTELIGENTE AUTOMÁTICO
// ----------------------------------------------------------------------------
// Periodicamente (diário ou semanal) agrega as detecções do período, monta um
// RESUMO inteligente e envia no WhatsApp do provedor. Exemplo de saída:
//
//   📊 Resumo da semana: 23 detecções — 18 pessoas, 5 veículos, 0 áudio.
//   Pico: terça 18h-19h. Nenhum evento de madrugada.
//
// Config fica em app_settings (key 'report'), no mesmo padrão de whatsapp.js /
// gemini.js. O scheduler é idempotente (igual startHealthMonitor) e nunca pode
// derrubar o servidor — por isso TUDO aqui é embrulhado em try/catch.
//
// O texto pode ser redigido pela IA (Gemini) quando useAI=true, mas SEMPRE há
// um fallback de texto fixo bem formatado caso a IA falhe ou esteja desligada.
// ============================================================================
import { pool } from './db.js'
import { sendWhatsApp } from './whatsapp.js'
import { getGeminiConfig } from './gemini.js'

const KEY = 'report'
// Fuso fixo do projeto — todas as decisões de hora/dia usam o horário local de
// São Paulo (o servidor pode rodar em UTC, então NUNCA confiamos no fuso do SO).
const TZ = 'America/Sao_Paulo'
const DEFAULT_MODEL = 'gemini-flash-latest'

// Config padrão quando ainda não há nada salvo (mantém o painel previsível).
const DEFAULT_CONFIG = {
  enabled: false,
  frequency: 'weekly', // 'daily' | 'weekly'
  time: '08:00', // HH:MM no horário local (America/Sao_Paulo)
  target: '', // grupo/número do WhatsApp; vazio = destino padrão do whatsapp
  useAI: false, // se true, o Gemini redige o texto a partir das estatísticas
}

// ----------------------------------------------------------------------------
// Config (mesmo padrão de getWaConfig/setWaConfig)
// ----------------------------------------------------------------------------

export async function getReportConfig() {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [KEY])
  // mescla com o default pra garantir que todos os campos sempre existam
  return { ...DEFAULT_CONFIG, ...(rows[0] ? rows[0].value : {}) }
}

export async function setReportConfig(cfg) {
  // Preserva o last_sent já gravado (a config do painel não o envia) pra não
  // perder o controle de "já enviei hoje" ao salvar pelas rotas.
  const prev = (await pool.query('SELECT value FROM app_settings WHERE key = $1', [KEY])).rows[0]
  const merged = { ...DEFAULT_CONFIG, ...cfg }
  if (prev && prev.value && prev.value.last_sent && cfg.last_sent === undefined) {
    merged.last_sent = prev.value.last_sent
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, merged]
  )
}

// Persiste a data (YYYY-MM-DD local) do último envio dentro da própria config.
// Serve de trava extra (além da memória) pra não reenviar após um restart.
async function persistLastSent(ymd) {
  try {
    const cfg = await getReportConfig()
    cfg.last_sent = ymd
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, cfg]
    )
  } catch (e) {
    // não é crítico: a trava em memória já evita reenvio no processo atual
    console.error('[report] persistLastSent:', e.message)
  }
}

// ----------------------------------------------------------------------------
// Helpers de data/hora no fuso local (America/Sao_Paulo)
// ----------------------------------------------------------------------------

// "agora" em São Paulo, normalizado em partes (YYYY-MM-DD, HH:MM, dia da semana).
// Usa Intl pra converter sem depender do fuso do SO.
function nowInSaoPaulo() {
  const d = new Date()
  // pt-BR + timeZone garante a hora LOCAL correta independentemente do servidor
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  })
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]))
  // 'en-CA' devolve hour '24' à meia-noite em alguns runtimes — normaliza pra '00'
  const hh = parts.hour === '24' ? '00' : parts.hour
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`, // ex 2026-06-11
    hhmm: `${hh}:${parts.minute}`, // ex 08:00
    weekday: parts.weekday, // ex 'Mon'
  }
}

// Rótulo do período pra usar no texto (ex "do dia 11/06" / "da semana").
function periodLabelFor(frequency) {
  return frequency === 'daily' ? 'do dia' : 'da semana'
}

// ----------------------------------------------------------------------------
// Agregação das detecções do período -> objeto de estatísticas estruturado
// ----------------------------------------------------------------------------

// Normaliza um ai_label livre vindo da IA em uma categoria conhecida pro resumo.
// (a IA pode devolver "pessoa", "veiculo", "carro", "fogo", etc.)
function categoriaDoLabel(label) {
  const l = String(label || '').toLowerCase()
  if (!l || l === 'nada') return 'outros'
  if (l.includes('pessoa') || l.includes('gente') || l.includes('homem') || l.includes('mulher'))
    return 'pessoa'
  if (l.includes('veic') || l.includes('carro') || l.includes('moto') || l.includes('caminh'))
    return 'veiculo'
  if (l.includes('animal') || l.includes('cachorro') || l.includes('gato')) return 'animal'
  if (l.includes('fogo') || l.includes('incend') || l.includes('fuma')) return 'fogo'
  return 'outros'
}

// buildReport(periodDays): agrega os events das últimas `periodDays` (>= now() -
// interval). Retorna um objeto de estatísticas pronto pra virar texto.
export async function buildReport(periodDays) {
  const days = Math.max(1, Number(periodDays) || 1)

  // Puxa os eventos do período já com o nome da câmera (JOIN). Limitamos as
  // colunas ao necessário pro resumo. started_at vem do banco (UTC); a hora do
  // dia é calculada no fuso local via SQL (AT TIME ZONE) pra achar o "pico".
  const { rows } = await pool.query(
    `SELECT e.id, e.type, e.ai_label, e.recognized,
            COALESCE(c.name, 'câmera removida') AS camera_name,
            EXTRACT(HOUR FROM (e.started_at AT TIME ZONE 'America/Sao_Paulo'))::int AS hour_local,
            to_char(e.started_at AT TIME ZONE 'America/Sao_Paulo', 'Dy') AS weekday_local
     FROM events e
     LEFT JOIN cameras c ON c.id = e.camera_id
     WHERE e.started_at >= now() - make_interval(days => $1)`,
    [days]
  )

  // Acumuladores
  const stats = {
    periodDays: days,
    total: rows.length,
    byType: { guardian: 0, audio: 0 }, // detecções por tipo
    byLabel: { pessoa: 0, veiculo: 0, animal: 0, fogo: 0, outros: 0 }, // por categoria
    recognized: 0, // reconhecidos (recognized não nulo)
    unknown: 0, // desconhecidos
    byCamera: {}, // { nome: contagem }
    byHour: new Array(24).fill(0), // distribuição 0..23h (local)
    overnight: 0, // eventos de madrugada (0h-5h)
    peak: null, // { weekday, hour, count } — janela de maior movimento
  }

  // Conta os pares (dia-da-semana + hora) pra achar a janela de pico realista.
  const peakBuckets = {} // 'Ter-18' -> count

  for (const r of rows) {
    // tipo (guardian | audio); valores inesperados são ignorados na contagem
    if (r.type === 'audio') stats.byType.audio++
    else stats.byType.guardian++

    // categoria do label
    stats.byLabel[categoriaDoLabel(r.ai_label)]++

    // reconhecido vs desconhecido
    if (r.recognized != null && String(r.recognized).trim() !== '') stats.recognized++
    else stats.unknown++

    // por câmera
    stats.byCamera[r.camera_name] = (stats.byCamera[r.camera_name] || 0) + 1

    // distribuição por hora + madrugada
    const h = Number.isFinite(r.hour_local) ? r.hour_local : null
    if (h != null && h >= 0 && h < 24) {
      stats.byHour[h]++
      if (h >= 0 && h < 5) stats.overnight++
      const wd = (r.weekday_local || '').trim()
      const bucketKey = `${wd}|${h}`
      peakBuckets[bucketKey] = (peakBuckets[bucketKey] || 0) + 1
    }
  }

  // Pico: a janela (dia+hora) com mais detecções. Só faz sentido se houver dados.
  let bestKey = null
  let bestCount = 0
  for (const [k, v] of Object.entries(peakBuckets)) {
    if (v > bestCount) {
      bestCount = v
      bestKey = k
    }
  }
  if (bestKey) {
    const [wd, hStr] = bestKey.split('|')
    stats.peak = { weekday: traduzDiaSemana(wd), hour: Number(hStr), count: bestCount }
  }

  // Top de câmeras (lista ordenada desc) pra usar no texto fixo
  stats.topCameras = Object.entries(stats.byCamera)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  return stats
}

// Traduz o "Dy" do Postgres (Mon/Tue/...) pra PT-BR pro texto do resumo.
function traduzDiaSemana(dy) {
  const map = {
    Mon: 'segunda',
    Tue: 'terça',
    Wed: 'quarta',
    Thu: 'quinta',
    Fri: 'sexta',
    Sat: 'sábado',
    Sun: 'domingo',
  }
  // o locale do banco pode devolver em PT já; normaliza pelas 3 primeiras letras
  const key = String(dy || '').slice(0, 3)
  return map[key] || (dy || '').toLowerCase()
}

// ----------------------------------------------------------------------------
// Texto do WhatsApp (IA opcional + fallback fixo SEMPRE disponível)
// ----------------------------------------------------------------------------

// Monta o TEXTO FIXO bem formatado a partir das estatísticas. É o fallback
// garantido — usado quando useAI=false ou quando a IA falha.
function buildFallbackText(stats, periodLabel) {
  const linhas = []
  linhas.push(`📊 *Resumo ${periodLabel}*`)
  linhas.push('')

  if (stats.total === 0) {
    linhas.push('Nenhuma detecção registrada no período. Tudo tranquilo. 👍')
    return linhas.join('\n')
  }

  // Linha principal: total + quebra por categoria mais relevante
  const partes = []
  if (stats.byLabel.pessoa) partes.push(`${stats.byLabel.pessoa} 🚶 pessoas`)
  if (stats.byLabel.veiculo) partes.push(`${stats.byLabel.veiculo} 🚗 veículos`)
  if (stats.byLabel.animal) partes.push(`${stats.byLabel.animal} 🐾 animais`)
  if (stats.byLabel.fogo) partes.push(`${stats.byLabel.fogo} 🔥 fogo`)
  if (stats.byType.audio) partes.push(`${stats.byType.audio} 🔊 áudio`)
  if (stats.byLabel.outros) partes.push(`${stats.byLabel.outros} 👁️ outros`)

  linhas.push(`Total: *${stats.total}* detecções${partes.length ? ' — ' + partes.join(', ') : ''}.`)

  // Reconhecidos vs desconhecidos (só se houver reconhecimento ativo)
  if (stats.recognized > 0) {
    linhas.push(`👤 ${stats.recognized} reconhecidos, ${stats.unknown} desconhecidos.`)
  }

  // Pico de movimento
  if (stats.peak) {
    const h = stats.peak.hour
    linhas.push(`🕐 Pico: ${stats.peak.weekday} ${h}h-${(h + 1) % 24}h (${stats.peak.count}).`)
  }

  // Câmeras mais movimentadas
  if (stats.topCameras && stats.topCameras.length) {
    const top = stats.topCameras.map((c) => `${c.name} (${c.count})`).join(', ')
    linhas.push(`📷 Mais movimento: ${top}.`)
  }

  // Madrugada (0h-5h) — destaque de segurança
  if (stats.overnight > 0) {
    linhas.push(`🌙 ${stats.overnight} evento(s) de madrugada (0h-5h).`)
  } else {
    linhas.push('🌙 Nenhum evento de madrugada.')
  }

  return linhas.join('\n')
}

// Pede ao Gemini um resumo curto e profissional a partir das estatísticas.
// Usa fetch direto (reaproveitando apiKey/model de getGeminiConfig) pra NÃO
// acoplar à análise de imagem. Retorna { ok, text } ou { ok:false, error }.
async function buildAIText(stats, periodLabel) {
  try {
    const cfg = await getGeminiConfig()
    if (!cfg || !cfg.apiKey) return { ok: false, error: 'Gemini não configurado' }

    const model = cfg.model || DEFAULT_MODEL
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`

    // Enviamos as estatísticas já calculadas (JSON) e pedimos só a REDAÇÃO —
    // a IA não precisa recontar nada, só transformar números em um resumo claro.
    const prompt = `Você é um assistente de uma empresa de monitoramento por câmeras (CFTV).
Escreva um RESUMO CURTO (máx 5 linhas), profissional e em português do Brasil, para enviar no WhatsApp do provedor, a partir das estatísticas ${periodLabel} abaixo (em JSON).
Use emojis com moderação (📊 📷 🚶 🚗 🔊 🕐 🌙) e destaque o total, os tipos principais, o horário de pico e se houve movimento de madrugada (0h-5h).
NÃO invente dados — use apenas o que está no JSON. Responda SOMENTE com o texto da mensagem, sem aspas e sem explicações.

Estatísticas:
${JSON.stringify(
      {
        total: stats.total,
        porTipo: stats.byType,
        porCategoria: stats.byLabel,
        reconhecidos: stats.recognized,
        desconhecidos: stats.unknown,
        topCameras: stats.topCameras,
        pico: stats.peak,
        madrugada_0h_5h: stats.overnight,
        periodoDias: stats.periodDays,
      },
      null,
      2
    )}`

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
    }

    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 20000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    clearTimeout(to)
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, error: `Gemini respondeu ${res.status}: ${t.slice(0, 160)}` }
    }
    const data = await res.json()
    const cand = data?.candidates?.[0]
    const text = (cand?.content?.parts?.map((p) => p.text || '').join('') || '').trim()
    if (!text) return { ok: false, error: 'Gemini não retornou texto' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Tempo esgotado' : e.message }
  }
}

// formatReportText(stats, periodLabel): decide entre IA e fixo.
// Se useAI && Gemini ok -> texto da IA; senão -> fallback fixo. SEMPRE retorna
// uma string utilizável (nunca lança).
export async function formatReportText(stats, periodLabel) {
  let useAI = false
  try {
    useAI = !!(await getReportConfig()).useAI
  } catch {
    useAI = false
  }

  if (useAI) {
    const ai = await buildAIText(stats, periodLabel)
    if (ai.ok && ai.text) return ai.text
    // IA falhou: loga e cai no fixo (nunca deixamos o provedor sem resumo)
    console.error('[report] IA falhou, usando texto fixo:', ai.error)
  }
  return buildFallbackText(stats, periodLabel)
}

// ----------------------------------------------------------------------------
// Envio
// ----------------------------------------------------------------------------

// sendReport: buildReport -> formatReportText -> sendWhatsApp(texto, target).
// Retorna { ok, sent, preview, error? } pra reuso pela rota de teste.
export async function sendReport(periodDays, periodLabel) {
  try {
    const cfg = await getReportConfig()
    const stats = await buildReport(periodDays)
    const text = await formatReportText(stats, periodLabel)

    // target vazio -> sendWhatsApp usa o destino padrão configurado no whatsapp
    const r = await sendWhatsApp(text, cfg.target || undefined)
    if (r && r.ok) {
      console.log(`[report] enviado (${stats.total} detecções)`)
      return { ok: true, sent: true, preview: text }
    }
    // texto gerado com sucesso, mas o WhatsApp não enviou (off/erro)
    return { ok: false, sent: false, preview: text, error: (r && r.error) || 'falha no WhatsApp' }
  } catch (e) {
    console.error('[report] sendReport erro:', e.message)
    return { ok: false, sent: false, preview: '', error: e.message }
  }
}

// ----------------------------------------------------------------------------
// Scheduler idempotente (mesmo padrão de startHealthMonitor)
// ----------------------------------------------------------------------------

let started = false
// Trava em memória: data (YYYY-MM-DD local) do último envio neste processo —
// evita reenviar no mesmo minuto/dia (o tick roda a cada 60s).
let lastSentYmd = null

// Verifica se está na hora de enviar e, se sim, envia. Nunca lança.
async function tick() {
  try {
    const cfg = await getReportConfig()
    if (!cfg.enabled) return

    const now = nowInSaoPaulo()

    // Hidrata a trava de memória com o last_sent persistido (após restart),
    // pra não reenviar caso o processo tenha reiniciado depois do envio do dia.
    if (lastSentYmd == null && cfg.last_sent) lastSentYmd = cfg.last_sent

    // 1) Já enviou hoje? (trava de memória + persistida) -> não reenvia
    if (lastSentYmd === now.ymd) return

    // 2) Bate o horário configurado (no minuto)?
    if (now.hhmm !== cfg.time) return

    // 3) Frequência: weekly só dispara na segunda-feira; daily todo dia
    if (cfg.frequency === 'weekly' && now.weekday.slice(0, 3) !== 'Mon') return

    // Tudo certo: marca ANTES de enviar (evita corrida/duplo envio se o envio
    // demorar mais que o intervalo do tick) e dispara.
    lastSentYmd = now.ymd
    await persistLastSent(now.ymd)

    const periodDays = cfg.frequency === 'daily' ? 1 : 7
    const periodLabel = periodLabelFor(cfg.frequency)
    await sendReport(periodDays, periodLabel)
  } catch (e) {
    console.error('[report] tick erro:', e.message)
  }
}

// Inicia o agendador. Idempotente: chamadas repetidas não criam timers extras.
export function startReportScheduler() {
  if (started) return
  started = true
  setInterval(tick, 60000) // verifica a cada 60s se está na hora
  console.log('[report] agendador de relatório inteligente iniciado')
}
