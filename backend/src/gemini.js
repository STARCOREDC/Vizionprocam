// Integração com o Google Gemini (visão) para análise inteligente das
// detecções do Modo Guardião: recebe o snapshot do movimento e classifica
// o que há na cena (pessoa / veículo / animal / nada relevante) + descrição.
//
// Config fica em app_settings (key 'gemini'): { apiKey, model, enabled, mode }.
//   - mode 'pessoas': só alerta quando há pessoa/veículo (descarta resto)
//   - mode 'tudo':    descreve e alerta qualquer coisa relevante
import { pool } from './db.js'

const KEY = 'gemini'
const DEFAULT_MODEL = 'gemini-flash-latest'

export async function getGeminiConfig() {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [KEY])
  return rows[0] ? rows[0].value : null
}

export async function setGeminiConfig(cfg) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, cfg]
  )
}

// Instrução de FOCO padrão (preset 'pessoas') — usada quando a câmera não
// define um foco específico. As outras instruções vêm dos detection_presets.
const DEFAULT_FOCUS = `Use "threat": true se for pessoa ou veículo (relevante para segurança); false para animal ou nada.
- "label": o principal elemento em MOVIMENTO/relevante na cena. Use "pessoa" se houver gente, "veiculo" para carro/moto/caminhão, "animal" para bichos, "nada" se for só sombra/luz/vegetação/cena vazia.`

// Monta o prompt de análise injetando a INSTRUÇÃO DE FOCO do preset da câmera
// dentro do template JSON fixo (mantém sempre o formato {threat,label,description}).
// focusInstruction vazia -> usa o foco padrão (pessoas).
export function buildPrompt(focusInstruction) {
  const foco = (focusInstruction && String(focusInstruction).trim()) || DEFAULT_FOCUS
  return `Você é um analista de segurança de CFTV. Analise a imagem desta câmera de segurança e responda SOMENTE com um JSON válido, sem texto extra, no formato:
{"threat": true|false, "label": "texto curto", "description": "frase curta em português"}

Foco desta análise (o que você deve procurar e quando considerar uma ameaça):
- ${foco}

Regras gerais:
- "label": uma palavra/expressão curta que resume o principal elemento relevante na cena (ex: "pessoa", "veiculo", "fogo", "queda", "animal", "nada").
- "threat": true quando o que foi pedido no foco acima estiver presente/for relevante para segurança; false caso contrário.
- "description": descreva em 1 frase curta o que vê (ex: "Uma pessoa de camiseta escura próxima à porta"). Seja objetivo.`
}

// Analisa um buffer JPEG. Retorna { ok, threat, label, description } ou { ok:false, error }.
// override: config ainda não salva (pra testar). Senão usa a config do banco.
// focusInstruction: instrução de FOCO do preset da câmera (o que a IA procura).
//   Vazia -> usa o foco padrão (pessoas).
export async function analyzeImage(jpegBuffer, override, focusInstruction) {
  const cfg = override && override.apiKey ? override : await getGeminiConfig()
  if (!cfg || !cfg.apiKey) {
    return { ok: false, error: 'Gemini não configurado (sem API Key).' }
  }
  // monta o prompt com a instrução de foco (ou o foco padrão se vazio)
  const prompt = buildPrompt(focusInstruction)
  const model = cfg.model || DEFAULT_MODEL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: jpegBuffer.toString('base64') } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      // responseMimeType força o modelo a devolver JSON puro (sem ```json) —
      // resolve o "resposta sem JSON". maxOutputTokens alto dá folga pros
      // modelos novos (2.5) que "pensam" antes de responder (o raciocínio
      // consome tokens; com pouco orçamento sobrava vazio).
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  }

  try {
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
      // Extrai a mensagem/status detalhado do Google (ex RESOURCE_EXHAUSTED).
      let detail = ''
      try {
        const j = JSON.parse(t)
        detail = j?.error?.message || j?.error?.status || ''
      } catch {
        detail = t.slice(0, 200)
      }
      let dica = ''
      if (res.status === 429) {
        dica =
          ' — Limite/quota do Google. Causas comuns: chave recém-criada (aguarde 2 min), free tier não ativo no projeto da chave, ou região. Tente criar a chave NOVA direto no aistudio.google.com/apikey.'
      } else if (res.status === 400 || res.status === 404) {
        dica = ' — Verifique o nome do modelo e a chave.'
      } else if (res.status === 403) {
        dica = ' — Chave inválida ou API "Generative Language" não habilitada.'
      }
      return { ok: false, error: `Gemini respondeu ${res.status}: ${detail}${dica}` }
    }
    const data = await res.json()
    const cand = data?.candidates?.[0]
    const text = cand?.content?.parts?.map((p) => p.text || '').join('') || ''
    if (!text) {
      // resposta vazia: geralmente o modelo "pensou" demais ou foi bloqueado
      const reason = cand?.finishReason || data?.promptFeedback?.blockReason || 'vazia'
      return {
        ok: false,
        error: `Gemini não retornou texto (motivo: ${reason}). Tente o modelo "gemini-flash-latest".`,
      }
    }
    // com responseMimeType json vem JSON puro; o regex é só um fallback.
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return { ok: false, error: 'Resposta do Gemini sem JSON', raw: text.slice(0, 200) }
      try {
        parsed = JSON.parse(m[0])
      } catch {
        return { ok: false, error: 'JSON inválido do Gemini', raw: text.slice(0, 200) }
      }
    }
    const label = String(parsed.label || 'nada').toLowerCase()
    return {
      ok: true,
      threat: !!parsed.threat,
      label,
      description: String(parsed.description || '').slice(0, 300),
    }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Tempo esgotado' : e.message }
  }
}

// ============================================================================
// RECONHECIMENTO DE MORADORES (#3) — compara a pessoa detectada com os rostos
// cadastrados do dono da câmera.
//
// IMPORTANTE / HONESTIDADE TÉCNICA: o Gemini NÃO é um motor de reconhecimento
// facial dedicado (não faz embeddings biométricos como FaceNet/ArcFace). Ele
// faz uma comparação visual "por descrição" do que vê. Na prática funciona
// RAZOÁVEL para poucas pessoas com fotos boas (rosto nítido, frontal, bem
// iluminado), mas NÃO é biometria precisa: pode confundir pessoas parecidas
// ou errar com ângulo/iluminação ruins. Por isso limitamos a ~5 rostos por
// chamada (mais que isso piora a precisão e encarece a chamada) e tratamos o
// resultado como uma DICA, não como verdade absoluta.
// ============================================================================

const MAX_KNOWN_FACES = 5 // teto de rostos por chamada (custo/precisão)

// Monta o prompt textual que instrui o modelo a comparar a detecção com os
// rostos conhecidos e responder SOMENTE com JSON.
function buildRecognizePrompt() {
  return `Você é um sistema de verificação de identidade para câmeras de segurança residencial.
Acima estão fotos de MORADORES CONHECIDOS (cada uma com o nome do morador) e, por último, a foto de uma PESSOA A IDENTIFICAR capturada agora pela câmera.

Sua tarefa: dizer se a PESSOA A IDENTIFICAR é um dos moradores conhecidos.

Responda SOMENTE com um JSON válido, sem texto extra, no formato:
{"recognized": "<nome do morador ou null>", "confidence": "alta|media|baixa", "description": "frase curta em português"}

Regras:
- "recognized": o NOME EXATO do morador conhecido se você tiver razoável certeza de que é a mesma pessoa; caso contrário null.
- Seja CONSERVADOR: só preencha um nome se as características faciais baterem de fato. Na dúvida, use null (é melhor tratar como desconhecido do que liberar um estranho).
- "confidence": sua confiança no resultado ("alta", "media" ou "baixa").
- "description": descreva em 1 frase curta a pessoa a identificar (ex: "Homem de barba, camiseta escura").`
}

// Reconhece (ou não) a pessoa da detecção comparando com os rostos conhecidos.
//   detectionBuffer: Buffer JPEG do snapshot da detecção atual.
//   knownFaces: [{ name, buffer }] — fotos dos moradores cadastrados (do dono).
// Retorna:
//   { ok:true, recognized:<nome|null>, confidence, description } em sucesso,
//   { ok:false, error } em qualquer falha (NUNCA lança — não pode quebrar o Guardião).
export async function recognizePerson(detectionBuffer, knownFaces) {
  try {
    if (!detectionBuffer) return { ok: false, error: 'sem imagem da detecção' }
    const faces = Array.isArray(knownFaces) ? knownFaces.filter((f) => f && f.buffer) : []
    if (!faces.length) return { ok: false, error: 'sem rostos cadastrados' }

    const cfg = await getGeminiConfig()
    if (!cfg || !cfg.apiKey) return { ok: false, error: 'Gemini não configurado (sem API Key).' }

    const model = cfg.model || DEFAULT_MODEL
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`

    // Monta as parts na ordem: [rosto conhecido 1 + nome] ... [foto a identificar].
    // Limita a MAX_KNOWN_FACES (precisão/custo).
    const parts = []
    for (const f of faces.slice(0, MAX_KNOWN_FACES)) {
      parts.push({ text: `Pessoa conhecida: ${String(f.name || 'desconhecido')}` })
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: f.buffer.toString('base64') } })
    }
    parts.push({ text: 'PESSOA A IDENTIFICAR:' })
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: detectionBuffer.toString('base64') } })
    // O prompt com as instruções vai por último (depois das imagens) pra o modelo
    // já ter visto todo o contexto antes de receber a pergunta.
    parts.push({ text: buildRecognizePrompt() })

    const body = {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
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
    const text = cand?.content?.parts?.map((p) => p.text || '').join('') || ''
    if (!text) {
      const reason = cand?.finishReason || data?.promptFeedback?.blockReason || 'vazia'
      return { ok: false, error: `Gemini não retornou texto (motivo: ${reason}).` }
    }
    // com responseMimeType json vem JSON puro; o regex é fallback.
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return { ok: false, error: 'Resposta do Gemini sem JSON' }
      try {
        parsed = JSON.parse(m[0])
      } catch {
        return { ok: false, error: 'JSON inválido do Gemini' }
      }
    }
    // Normaliza: "recognized" pode vir como null, "null" (string) ou vazio -> tudo vira null.
    let recognized = parsed.recognized
    if (recognized == null) recognized = null
    else {
      recognized = String(recognized).trim()
      if (!recognized || recognized.toLowerCase() === 'null') recognized = null
    }
    return {
      ok: true,
      recognized,
      confidence: String(parsed.confidence || 'baixa').toLowerCase(),
      description: String(parsed.description || '').slice(0, 300),
    }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Tempo esgotado' : e.message }
  }
}

// Rótulo amigável + emoji por label (pro alerta).
export function labelInfo(label) {
  switch (label) {
    case 'pessoa':
      return { emoji: '🚶', titulo: 'Pessoa detectada' }
    case 'veiculo':
      return { emoji: '🚗', titulo: 'Veículo detectado' }
    case 'animal':
      return { emoji: '🐾', titulo: 'Animal detectado' }
    default:
      return { emoji: '👁️', titulo: 'Movimento detectado' }
  }
}
