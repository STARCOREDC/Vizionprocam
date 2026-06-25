import { spawn } from 'node:child_process'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pool } from './db.js'
import { getSnapshot, getOnlinePaths } from './mediamtx.js'
import { getGeminiConfig, analyzeImage, recognizePerson, labelInfo } from './gemini.js'
import { sendWhatsApp } from './whatsapp.js'
import { sendPushToUsers } from './push.js'

// RTSP local do Mediamtx (mesmo valor usado no mediamtx.js).
// Importar de lá criaria acoplamento desnecessário (não é exportado), então
// redefinimos com o mesmo fallback/env.
const RTSP_LOCAL = process.env.MEDIAMTX_RTSP || 'rtsp://localhost:8554'

// Diretório onde os snapshots dos eventos são salvos (no banco fica só o filename)
const EVENTS_DIR = '/opt/vizionpro/events'

// Diretório com as fotos dos moradores cadastrados (reconhecimento de rostos #3).
// No banco (known_persons.photo) fica só o filename; o arquivo vive aqui.
const FACES_DIR = '/opt/vizionpro/faces'

// Máximo de rostos conhecidos enviados por chamada de reconhecimento.
// Mais que isso piora a precisão do Gemini e encarece a chamada (ver gemini.js).
const MAX_FACES_PER_CALL = 5

// Limiar de detecção de cena por sensibilidade (menor = mais sensível).
// O ffmpeg só emite score quando o frame PASSA do limiar (select gt(scene,SENS)),
// então toda linha de score já representa movimento acima do gatilho.
const SENS_BY_LEVEL = {
  alta: 0.035,
  media: 0.06,
  baixa: 0.1,
}
function sensValue(level) {
  return SENS_BY_LEVEL[level] || SENS_BY_LEVEL.media
}

// Cooldown entre disparos por câmera — movimento contínuo não floda alertas.
const FIRE_COOLDOWN_MS = 30_000

// Cooldown PRÓPRIO do áudio (#2) — separado do de vídeo pra que barulho contínuo
// (ex chuva forte, obra) não floode, sem interferir nos disparos de movimento.
const AUDIO_COOLDOWN_MS = 30_000

// Map de câmeras armadas (vídeo/cena): cameraId -> { proc, slug, lastFireAt }
const armed = new Map()

// Map SEPARADO das câmeras com monitoração de áudio ligada (#2):
//   cameraId -> { proc, slug, threshold, lastFireAt }
// Mantido à parte do `armed` pra deixar o ciclo de vida de cada ffmpeg simples
// e independente (um pode reiniciar sem afetar o outro).
const audioArmed = new Map()

let started = false

// usuários (viewer) que podem ver a câmera — p/ alerta in-app
// (mesma lógica do health.js / motion.js)
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

// Registra UMA chamada de IA no ai_usage (telemetria de uso/custo).
// label: rótulo retornado pela IA, ou 'erro' quando a análise falhou.
// Isolado em try/catch: nunca pode quebrar o fluxo do Guardião.
async function logAiUsage(cameraId, label) {
  try {
    await pool.query(
      `INSERT INTO ai_usage (camera_id, label) VALUES ($1, $2)`,
      [cameraId, String(label || 'erro').slice(0, 60)]
    )
  } catch (e) {
    console.error(`[guardian] ai_usage insert:`, e.message)
  }
}

// Conta as análises de IA já feitas HOJE nesta câmera (pro limite diário).
async function aiCallsToday(cameraId) {
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS c FROM ai_usage
       WHERE camera_id = $1 AND created_at::date = now()::date`,
      [cameraId]
    )
    return rows[0] ? rows[0].c : 0
  } catch (e) {
    console.error(`[guardian] ai_usage count:`, e.message)
    return 0 // em erro de contagem, não bloqueia a IA
  }
}

// Carrega a instrução de FOCO da câmera (o que a IA deve procurar) + o emoji
// do preset (pro título do alerta). Resolve:
//   - focus='custom'  -> usa guardian_focus_custom como instrução (emoji genérico)
//   - focus='<key>'   -> SELECT prompt,emoji FROM detection_presets WHERE key=<key>
//   - fallback 'pessoas' (ou vazio) -> instrução nula => gemini usa o foco padrão.
// guardian_focus pode ter VÁRIOS focos separados por vírgula (ex: "pessoas,fogo").
// Combinamos as instruções dos presets escolhidos num único prompt; a IA dispara
// se QUALQUER um for detectado. 'custom' usa o texto livre da câmera.
async function loadFocus(cam) {
  const raw = (cam.guardian_focus || 'pessoas').trim()
  const keys = raw.split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const presetKeys = keys.filter((k) => k !== 'custom')
    const parts = []
    let emoji = '🛡️'

    if (presetKeys.length) {
      const { rows } = await pool.query(
        `SELECT key, prompt, emoji FROM detection_presets WHERE key = ANY($1)`,
        [presetKeys]
      )
      for (const r of rows) if (r.prompt) parts.push(r.prompt)
      // emoji: do preset único; com vários, usa o escudo genérico
      if (rows.length === 1 && rows[0].emoji) emoji = rows[0].emoji
    }
    // foco personalizado (texto livre do cliente)
    if (keys.includes('custom')) {
      const instr = (cam.guardian_focus_custom || '').trim()
      if (instr) parts.push(instr)
      if (parts.length === 1) emoji = '🎯'
    }

    if (parts.length === 1) return { instruction: parts[0], emoji }
    if (parts.length > 1) {
      const instruction =
        'Monitore TODOS estes itens; threat=true se QUALQUER um estiver presente na cena: ' +
        parts.map((p, i) => `(${i + 1}) ${p}`).join(' ')
      return { instruction, emoji }
    }
  } catch (e) {
    console.error(`[guardian] loadFocus (${cam.slug}):`, e.message)
  }
  // sem foco válido -> padrão (pessoas), instrução nula
  return { instruction: null, emoji: '🛡️' }
}

// Carrega os rostos cadastrados dos DONOS da câmera (#3).
// "Dono" = os viewers que enxergam a câmera (usersForCamera). Pegamos os
// known_persons desses usuários, lemos as fotos de FACES_DIR e devolvemos
// [{ name, buffer }] pronto pro recognizePerson. Limita a MAX_FACES_PER_CALL.
// Nunca lança: em qualquer erro devolve [] (cai no comportamento atual de pessoa).
async function loadKnownFaces(cameraId) {
  try {
    const users = await usersForCamera(cameraId)
    const ownerIds = users.map((u) => u.id)
    if (!ownerIds.length) return []

    const { rows } = await pool.query(
      `SELECT name, photo FROM known_persons
       WHERE owner_user_id = ANY($1::int[])
       ORDER BY created_at ASC
       LIMIT $2`,
      [ownerIds, MAX_FACES_PER_CALL]
    )

    const faces = []
    for (const r of rows) {
      if (!r.photo) continue
      try {
        // photo no banco é só o filename; o arquivo vive em FACES_DIR.
        const buffer = await readFile(join(FACES_DIR, r.photo))
        faces.push({ name: r.name, buffer })
      } catch (e) {
        // foto faltando/corrompida -> ignora esse rosto, segue com os outros
        console.error(`[guardian] foto morador ausente (${r.photo}):`, e.message)
      }
    }
    return faces
  } catch (e) {
    console.error(`[guardian] loadKnownFaces (cam ${cameraId}):`, e.message)
    return []
  }
}

// Dispara um evento de Guardião: snapshot + INSERT em events + alerta in-app.
// Sem WhatsApp aqui (decisão do dono: Guardião notifica só no app/sininho).
async function fireGuardian(cam) {
  const ts = Date.now()
  console.log(`[guardian] movimento detectado na câmera ${cam.name} (${cam.slug})`)

  // (a) snapshot do stream local — se falhar, segue sem imagem (null no banco)
  // Guardamos o Buffer (snapBuf) pra reaproveitar na análise da IA — NÃO tiramos
  // outro snapshot só pra IA.
  let snapshot = null
  let snapBuf = null
  try {
    // fresh: foto do INSTANTE do movimento (sem cache), senão a IA vê frame vazio
    snapBuf = await getSnapshot(cam.slug, { fresh: true })
    const filename = `${cam.slug}-guardian-${ts}.jpg`
    await writeFile(join(EVENTS_DIR, filename), snapBuf)
    snapshot = filename
  } catch (e) {
    console.log(`[guardian] snapshot falhou (${cam.slug}): ${e.message}`)
  }

  // (b) análise por IA (Gemini) — opcional. Define:
  //   - aiLabel / aiDescription: salvos no evento (null quando sem IA)
  //   - alertTitle / alertMessage: textos do alerta in-app
  //   - skipAlert: quando a IA descartou (modo 'pessoas' + cena irrelevante)
  let aiLabel = null
  let aiDescription = null
  let alertTitle = '🛡️ Movimento detectado'
  let alertMessage = `Movimento detectado na câmera "${cam.name}".`
  let alertLevel = 'warning' // nível do alerta in-app (warning padrão)
  let skipAlert = false
  let recognized = null // nome do morador reconhecido (#3), ou null

  try {
    const gcfg = await getGeminiConfig()
    // só roda a IA se: ligada, com chave E temos um buffer de imagem pra analisar
    if (gcfg?.enabled && gcfg.apiKey && snapBuf) {
      // LIMITE DIÁRIO: se a câmera tem teto (>0) e já estourou, PULA a IA e
      // emite um alerta genérico (registra o evento sem classificação).
      const limit = Number(cam.ai_daily_limit) > 0 ? Number(cam.ai_daily_limit) : 0
      if (limit > 0 && (await aiCallsToday(cam.id)) >= limit) {
        console.log(`[guardian] limite diário de IA atingido (${limit}) - câmera ${cam.slug}`)
      } else {
        // FOCO da câmera: define O QUE a IA procura (preset ou custom).
        const focus = await loadFocus(cam)
        // reutiliza o MESMO buffer do snapshot; passa a instrução de foco
        const r = await analyzeImage(snapBuf, undefined, focus.instruction)
        // telemetria de uso/custo: TODA chamada (sucesso ou erro) é registrada
        await logAiUsage(cam.id, r.ok ? r.label : 'erro')
        if (r.ok) {
          // guarda classificação pra salvar no evento
          aiLabel = r.label
          aiDescription = r.description || null
          // mode global continua valendo como FALLBACK pro descarte:
          // 'pessoas' descarta o que a IA marcou como não-ameaça; 'tudo' alerta sempre.
          const mode = gcfg.mode === 'tudo' ? 'tudo' : 'pessoas' // default 'pessoas'

          if (mode === 'pessoas' && r.threat === false) {
            // irrelevante pro foco -> registra o evento mas NÃO alerta
            skipAlert = true
            console.log(`[guardian] IA descartou (${r.label}) - sem alerta`)
          } else {
            // ameaça (threat) OU modo 'tudo' -> alerta enriquecido pela IA.
            // Usa o emoji do PRESET no título (fallback pro labelInfo do label).
            const info = labelInfo(r.label)
            const emoji = focus.emoji || info.emoji
            alertTitle = `${emoji} ${info.titulo}`
            const baseMsg = r.description || `Movimento detectado na câmera "${cam.name}".`
            alertMessage = `${baseMsg} — ${cam.name}`

            // ----------------------------------------------------------------
            // RECONHECIMENTO DE MORADORES (#3) — só quando:
            //   - a IA detectou uma PESSOA (label='pessoa'), E
            //   - a câmera tem face_recognition ligado, E
            //   - há rostos cadastrados pelos donos.
            // Caso contrário mantém o comportamento ATUAL (alerta normal de pessoa).
            // ----------------------------------------------------------------
            if (cam.face_recognition === true && r.label === 'pessoa') {
              try {
                const knownFaces = await loadKnownFaces(cam.id)
                if (knownFaces.length) {
                  const rec = await recognizePerson(snapBuf, knownFaces)
                  // telemetria também pra a chamada de reconhecimento (label 'face')
                  await logAiUsage(cam.id, rec.ok ? 'face' : 'erro')
                  if (rec.ok) {
                    if (rec.recognized) {
                      // MORADOR RECONHECIDO -> não trata como invasor.
                      // Escolha do dono: alerta INFORMATIVO suave (chegada),
                      // em vez de silenciar de vez (fica visível no sininho).
                      recognized = rec.recognized
                      alertTitle = `✅ ${rec.recognized} chegou`
                      alertMessage = `${rec.recognized} foi reconhecido(a) na câmera "${cam.name}".`
                      alertLevel = 'info'
                    } else {
                      // PESSOA NÃO RECONHECIDA -> alerta REFORÇADO (crítico).
                      alertTitle = '🚨 Pessoa não reconhecida'
                      alertMessage = `Pessoa não reconhecida na câmera "${cam.name}".`
                      alertLevel = 'critical'
                    }
                  } else {
                    // falha no reconhecimento -> mantém o alerta normal de pessoa
                    console.error(`[guardian] reconhecimento falhou (${cam.slug}): ${rec.error}`)
                  }
                }
              } catch (e) {
                // qualquer exceção no reconhecimento -> segue com alerta normal
                console.error(`[guardian] reconhecimento exceção (${cam.slug}):`, e.message)
              }
            }
          }
        } else {
          // erro/timeout da IA -> FALLBACK pro alerta genérico (nunca quebra o Guardião)
          console.error(`[guardian] IA falhou (${cam.slug}): ${r.error || 'erro desconhecido'}`)
        }
      }
    }
  } catch (e) {
    // qualquer exceção inesperada da IA -> fallback genérico
    console.error(`[guardian] IA exceção (${cam.slug}):`, e.message)
  }

  // (c) registra o evento (type 'guardian') — com classificação da IA quando houver
  // e o morador reconhecido (#3) quando aplicável (null nos demais casos).
  try {
    await pool.query(
      `INSERT INTO events (camera_id, type, snapshot, ai_label, ai_description, recognized)
       VALUES ($1, 'guardian', $2, $3, $4, $5)`,
      [cam.id, snapshot, aiLabel, aiDescription, recognized]
    )
  } catch (e) {
    console.error(`[guardian] insert event (${cam.slug}):`, e.message)
  }

  // (d) alerta in-app — para cada viewer que enxerga a câmera.
  // Se a IA descartou (skipAlert), pula essa etapa (evento fica registrado só no histórico).
  if (skipAlert) return
  try {
    const users = await usersForCamera(cam.id)
    for (const u of users) {
      await pool
        .query(
          `INSERT INTO alerts (title, message, level, target_type, target_id)
           VALUES ($1, $2, $3, 'user', $4)`,
          [alertTitle, alertMessage, alertLevel, u.id]
        )
        .catch(() => {})
    }

    // push (ADICIONAL) — mesmos usuários e mesmo título/mensagem do alerta in-app.
    sendPushToUsers(
      users.map((u) => u.id),
      {
        title: alertTitle,
        body: alertMessage,
        data: { type: 'guardian', cameraId: cam.id },
      }
    )
  } catch (e) {
    console.error(`[guardian] alerta (${cam.slug}):`, e.message)
  }
}

// Inicia o ffmpeg de análise de cena pra UMA câmera (decode-only, sem reencode).
function armCamera(cam) {
  const sens = sensValue(cam.guardian_sensitivity)
  // -an: ignora áudio. select gt(scene,SENS) + metadata=print imprime o
  // lavfi.scene_score só dos frames que passam o limiar. -f null: descarta saída.
  const args = [
    '-rtsp_transport', 'tcp',
    '-i', `${RTSP_LOCAL}/${cam.slug}`,
    '-an',
    '-vf', `select='gt(scene,${sens})',metadata=print`,
    '-f', 'null',
    '-',
  ]

  let proc
  try {
    // stdbuf -oL -eL: força line-buffering. Sem isso o ffmpeg, com stderr
    // redirecionado pra pipe, SEGURA as mensagens de metadata no buffer e o
    // Node só recebe quando enche/termina -> detecção nunca disparava ao vivo.
    proc = spawn('stdbuf', ['-oL', '-eL', 'ffmpeg', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (e) {
    console.error(`[guardian] falha ao iniciar ffmpeg (${cam.slug}):`, e.message)
    return
  }

  const entry = { proc, slug: cam.slug, lastFireAt: 0, sens }
  armed.set(cam.id, entry)
  console.log(`[guardian] armou câmera ${cam.name} (${cam.slug}) sens=${sens}`)

  // Cada linha com scene_score= é um frame que passou o limiar = movimento.
  proc.stderr.on('data', (chunk) => {
    try {
      const text = chunk.toString()
      const m = text.match(/scene_score=([0-9.]+)/)
      if (!m) return
      console.log(`[guardian] cena mudou em ${cam.slug} score=${m[1]}`)
      const now = Date.now()
      // debounce/cooldown: só dispara se passou > 30s do último disparo
      if (now - entry.lastFireAt < FIRE_COOLDOWN_MS) return
      entry.lastFireAt = now
      fireGuardian(cam).catch((e) =>
        console.error(`[guardian] fireGuardian (${cam.slug}):`, e.message)
      )
    } catch (e) {
      console.error(`[guardian] stderr (${cam.slug}):`, e.message)
    }
  })

  // Se o ffmpeg sair/erro, remove do Map -> reinicia no próximo ciclo de 20s.
  proc.on('error', (e) => {
    console.log(`[guardian] erro ffmpeg câmera ${cam.name}: ${e?.message || e}`)
    armed.delete(cam.id)
  })
  proc.on('exit', (code) => {
    console.log(`[guardian] ffmpeg saiu (${cam.slug}) code=${code} — re-armará no próximo ciclo`)
    armed.delete(cam.id)
  })
}

// Mata o ffmpeg de uma câmera e remove do Map (desarmou/removeu).
function disarmCamera(id) {
  const entry = armed.get(id)
  if (!entry) return
  try {
    entry.proc.kill('SIGKILL')
  } catch {
    // já morreu — ignora
  }
  armed.delete(id)
  console.log(`[guardian] desarmou câmera ${entry.slug}`)
}

// ============================================================================
// DETECÇÃO DE ÁUDIO (#2) — barulho anormal (vidro, grito, batida).
// ffmpeg SEPARADO do de vídeo: mede o nível RMS do áudio do stream e dispara
// quando passa o limiar. Sem IA — é puramente nível sonoro.
// ============================================================================

// Dispara um evento de ÁUDIO: snapshot + INSERT events(type='audio') + alerta.
// Não usa IA (decisão do dono: é só nível sonoro). Nunca lança.
async function fireAudioEvent(cam) {
  const ts = Date.now()
  console.log(`[guardian] barulho detectado na câmera ${cam.name} (${cam.slug})`)

  // (a) snapshot fresco do instante do barulho (contexto visual pro evento)
  let snapshot = null
  try {
    const snapBuf = await getSnapshot(cam.slug, { fresh: true })
    const filename = `${cam.slug}-audio-${ts}.jpg`
    await writeFile(join(EVENTS_DIR, filename), snapBuf)
    snapshot = filename
  } catch (e) {
    console.log(`[guardian] snapshot áudio falhou (${cam.slug}): ${e.message}`)
  }

  // (b) registra o evento (type 'audio')
  try {
    await pool.query(
      `INSERT INTO events (camera_id, type, snapshot) VALUES ($1, 'audio', $2)`,
      [cam.id, snapshot]
    )
  } catch (e) {
    console.error(`[guardian] insert event áudio (${cam.slug}):`, e.message)
  }

  // (c) alerta in-app pros viewers da câmera
  try {
    const users = await usersForCamera(cam.id)
    const title = '🔊 Som detectado'
    const message = `Barulho detectado na câmera "${cam.name}".`
    for (const u of users) {
      await pool
        .query(
          `INSERT INTO alerts (title, message, level, target_type, target_id)
           VALUES ($1, $2, 'warning', 'user', $3)`,
          [title, message, u.id]
        )
        .catch(() => {})
    }

    // push (ADICIONAL) — mesmos usuários e texto do alerta in-app.
    sendPushToUsers(
      users.map((u) => u.id),
      {
        title,
        body: message,
        data: { type: 'audio', cameraId: cam.id },
      }
    )
  } catch (e) {
    console.error(`[guardian] alerta áudio (${cam.slug}):`, e.message)
  }
}

// Inicia o ffmpeg de análise de ÁUDIO pra UMA câmera.
// astats (reset=1) recalcula o RMS a cada janela; ametadata=print imprime só o
// RMS_level no stderr. -vn ignora vídeo. -f null descarta a saída.
function armAudio(cam) {
  const threshold = Number(cam.audio_threshold_db)
  const args = [
    '-rtsp_transport', 'tcp',
    '-i', `${RTSP_LOCAL}/${cam.slug}`,
    '-vn',
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null',
    '-',
  ]

  let proc
  try {
    // MESMO fix de line-buffering do scene (stdbuf -oL -eL): sem isso o ffmpeg
    // segura as linhas de metadata no buffer e o Node não recebe em tempo real.
    proc = spawn('stdbuf', ['-oL', '-eL', 'ffmpeg', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (e) {
    console.error(`[guardian] falha ao iniciar ffmpeg áudio (${cam.slug}):`, e.message)
    return
  }

  const entry = { proc, slug: cam.slug, threshold, lastFireAt: 0 }
  audioArmed.set(cam.id, entry)
  console.log(`[guardian] armou áudio ${cam.name} (${cam.slug}) limiar=${threshold}dB`)

  proc.stderr.on('data', (chunk) => {
    try {
      const text = chunk.toString()
      // pode vir mais de uma linha por chunk — varre todas
      const re = /RMS_level=(-?[0-9.]+)/g
      let m
      while ((m = re.exec(text)) !== null) {
        const rms = parseFloat(m[1])
        if (!Number.isFinite(rms)) continue
        // rms em dB (negativo; perto de 0 = mais ALTO). Comparação numérica
        // direta funciona: -10 > -18 => barulho acima do limiar.
        if (rms <= entry.threshold) continue
        const now = Date.now()
        if (now - entry.lastFireAt < AUDIO_COOLDOWN_MS) continue
        entry.lastFireAt = now
        console.log(`[guardian] áudio ${cam.slug} RMS=${rms}dB > ${entry.threshold}dB`)
        fireAudioEvent(cam).catch((e) =>
          console.error(`[guardian] fireAudioEvent (${cam.slug}):`, e.message)
        )
      }
    } catch (e) {
      console.error(`[guardian] stderr áudio (${cam.slug}):`, e.message)
    }
  })

  // Se sair/erro, remove do Map -> re-arma no próximo ciclo de sync.
  proc.on('error', (e) => {
    console.log(`[guardian] erro ffmpeg áudio ${cam.name}: ${e?.message || e}`)
    audioArmed.delete(cam.id)
  })
  proc.on('exit', (code) => {
    console.log(`[guardian] ffmpeg áudio saiu (${cam.slug}) code=${code} — re-armará no próximo ciclo`)
    audioArmed.delete(cam.id)
  })
}

// Mata o ffmpeg de áudio de uma câmera e remove do Map.
function disarmAudio(id) {
  const entry = audioArmed.get(id)
  if (!entry) return
  try {
    entry.proc.kill('SIGKILL')
  } catch {
    // já morreu — ignora
  }
  audioArmed.delete(id)
  console.log(`[guardian] desarmou áudio ${entry.slug}`)
}

// Ciclo de sincronização (20s): arma as novas, desarma as que saíram.
async function syncGuardians() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, rtsp_url, location, guardian_sensitivity,
              guardian_focus, guardian_focus_custom, tamper_detect, ai_daily_limit,
              face_recognition, audio_detect, audio_threshold_db
       FROM cameras WHERE enabled = true AND guardian = true`
    )
    const wanted = new Map(rows.map((c) => [c.id, c]))

    // desarma as que saíram (desabilitadas / guardian=false / deletadas)
    for (const id of [...armed.keys()]) {
      if (!wanted.has(id)) disarmCamera(id)
    }

    // arma as novas; re-arma se a sensibilidade mudou (ffmpeg precisa reiniciar)
    for (const c of rows) {
      const entry = armed.get(c.id)
      if (entry && entry.sens !== sensValue(c.guardian_sensitivity)) {
        disarmCamera(c.id) // sensibilidade mudou -> mata e recria com novo limiar
      }
      if (!armed.has(c.id)) {
        try {
          armCamera(c)
        } catch (e) {
          console.error(`[guardian] arm (${c.slug}):`, e.message)
        }
      }
    }

    // ----- ÁUDIO (#2): arma quando guardian=true E audio_detect=true -----
    // Desarma as que não querem mais áudio (câmera saiu da lista OU audio_detect off).
    for (const id of [...audioArmed.keys()]) {
      const c = wanted.get(id)
      if (!c || c.audio_detect !== true) disarmAudio(id)
    }
    for (const c of rows) {
      if (c.audio_detect !== true) continue
      const entry = audioArmed.get(c.id)
      // re-arma se o limiar mudou (o ffmpeg precisa do novo valor na comparação)
      if (entry && entry.threshold !== Number(c.audio_threshold_db)) {
        disarmAudio(c.id)
      }
      if (!audioArmed.has(c.id)) {
        try {
          armAudio(c)
        } catch (e) {
          console.error(`[guardian] arm áudio (${c.slug}):`, e.message)
        }
      }
    }
  } catch (e) {
    console.error('[guardian] sync erro:', e.message)
  }
}

// ============================================================================
// AGENDAMENTO (#1) — arma/desarma automaticamente conforme horário/dia.
// ============================================================================

// Minutos desde a meia-noite no fuso America/Sao_Paulo + dia da semana (dom=0).
// Usamos toLocaleString com timeZone pra não depender do TZ do servidor.
function nowInSaoPaulo() {
  try {
    const tz = 'America/Sao_Paulo'
    // hora/minuto local de SP
    const hm = new Date().toLocaleString('en-US', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    })
    const [h, m] = hm.split(':').map((n) => parseInt(n, 10))
    // dia da semana local de SP (0=dom..6=sab)
    const wdName = new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'short' })
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const day = map[wdName] ?? new Date().getDay()
    return { minutes: h * 60 + m, day }
  } catch {
    const d = new Date()
    return { minutes: d.getHours() * 60 + d.getMinutes(), day: d.getDay() }
  }
}

// "HH:MM" -> minutos desde meia-noite (null se inválido)
function hhmmToMin(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mi = parseInt(m[2], 10)
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

// A agenda diz que a câmera deve estar ARMADA agora?
// Suporta janela que cruza meia-noite (ex 22:00->06:00).
// O dia checado é o dia em que a janela COMEÇA (start).
function scheduleWantsArmed(sched, now) {
  if (!sched || !sched.enabled) return null // sem agenda -> não interfere
  const days = Array.isArray(sched.days) ? sched.days.map(Number) : []
  const start = hhmmToMin(sched.start)
  const end = hhmmToMin(sched.end)
  if (start == null || end == null) return null // agenda malformada -> ignora
  const { minutes, day } = now
  if (start === end) return false // janela vazia
  if (start < end) {
    // janela normal no mesmo dia
    return days.includes(day) && minutes >= start && minutes < end
  }
  // janela cruza a meia-noite: vale do dia de início (>= start) e
  // continua na madrugada do dia seguinte (< end). Pro trecho da madrugada,
  // o dia "de início" é o dia anterior.
  const prevDay = (day + 6) % 7
  if (minutes >= start) return days.includes(day) // ainda no dia de início, à noite
  if (minutes < end) return days.includes(prevDay) // madrugada do dia seguinte
  return false
}

// Ciclo do agendador (60s): lê câmeras com agenda ativa e ajusta guardian no
// banco quando MUDOU (UPDATE condicional pra não martelar à toa). O sync de 20s
// respeita o guardian do banco, então aqui só mexemos no banco.
async function scheduleTick() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, guardian, guardian_schedule
       FROM cameras
       WHERE enabled = true AND guardian_schedule IS NOT NULL
         AND (guardian_schedule->>'enabled')::boolean = true`
    )
    if (!rows.length) return
    const now = nowInSaoPaulo()
    for (const c of rows) {
      try {
        const want = scheduleWantsArmed(c.guardian_schedule, now)
        if (want === null) continue // agenda inválida/desligada -> não mexe
        if (want && !c.guardian) {
          // garante armado (só se estava desarmado)
          const upd = await pool.query(
            `UPDATE cameras SET guardian = true WHERE id = $1 AND guardian = false`,
            [c.id]
          )
          if (upd.rowCount) console.log(`[guardian] agenda: armou ${c.name} (${c.slug})`)
        } else if (!want && c.guardian) {
          const upd = await pool.query(
            `UPDATE cameras SET guardian = false WHERE id = $1 AND guardian = true`,
            [c.id]
          )
          if (upd.rowCount) console.log(`[guardian] agenda: desarmou ${c.name} (${c.slug})`)
        }
      } catch (e) {
        console.error(`[guardian] agenda (${c.slug}):`, e.message)
      }
    }
  } catch (e) {
    console.error('[guardian] agenda tick erro:', e.message)
  }
}

// ============================================================================
// SABOTAGEM (#4) — câmera com tamper_detect E armada que fica OFFLINE.
// ============================================================================

// Estado por câmera: misses consecutivos + cooldown do último alerta.
const tamperState = new Map() // cameraId -> { misses, lastAlertAt }
const TAMPER_MISSES = 3 // ~3 ciclos seguidos offline = sabotagem
const TAMPER_COOLDOWN_MS = 10 * 60_000 // não repete alerta por 10 min

async function tamperAlert(cam) {
  const title = '🚨 Possível sabotagem'
  const message = `A câmera "${cam.name}" foi obstruída ou desconectada enquanto o Guardião estava ativo.`
  // in-app pros viewers
  try {
    const users = await usersForCamera(cam.id)
    for (const u of users) {
      await pool
        .query(
          `INSERT INTO alerts (title, message, level, target_type, target_id)
           VALUES ($1, $2, 'critical', 'user', $3)`,
          [title, message, u.id]
        )
        .catch(() => {})
    }
  } catch (e) {
    console.error(`[guardian] tamper alerta (${cam.slug}):`, e.message)
  }
  // WhatsApp pro provedor (opcional; isolado)
  try {
    sendWhatsApp(
      `🚨 *POSSÍVEL SABOTAGEM*\n\n📷 Câmera: *${cam.name}*\n${title} — câmera obstruída ou desconectada com o Guardião ativo.\n🕐 ${new Date().toLocaleString(
        'pt-BR',
        { timeZone: 'America/Sao_Paulo' }
      )}`
    ).catch(() => {})
  } catch {
    // ignore
  }
}

// Ciclo de checagem de sabotagem (20s): só câmeras tamper_detect + armadas.
async function tamperTick() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug FROM cameras
       WHERE enabled = true AND guardian = true AND tamper_detect = true`
    )
    if (!rows.length) {
      tamperState.clear()
      return
    }
    const online = await getOnlinePaths()
    const liveIds = new Set(rows.map((c) => c.id))
    // limpa estado de câmeras que não estão mais monitoradas
    for (const id of [...tamperState.keys()]) if (!liveIds.has(id)) tamperState.delete(id)

    for (const c of rows) {
      const st = tamperState.get(c.id) || { misses: 0, lastAlertAt: 0 }
      if (online.has(c.slug)) {
        st.misses = 0
      } else {
        st.misses += 1
        if (
          st.misses >= TAMPER_MISSES &&
          Date.now() - st.lastAlertAt > TAMPER_COOLDOWN_MS
        ) {
          st.lastAlertAt = Date.now()
          console.log(`[guardian] sabotagem suspeita em ${c.slug} (offline armada)`)
          await tamperAlert(c)
        }
      }
      tamperState.set(c.id, st)
    }
  } catch (e) {
    console.error('[guardian] tamper tick erro:', e.message)
  }
}

// Inicia o motor do Modo Guardião (idempotente, como startHealthMonitor).
// A limpeza de events (7 dias) já é feita pelo motion.js — não duplicamos aqui.
export function startGuardian() {
  if (started) return
  started = true
  syncGuardians()
  setInterval(syncGuardians, 20_000) // sincroniza câmeras armadas a cada 20s
  // agendador: arma/desarma conforme horário (a cada 60s; não conflita com o sync)
  scheduleTick()
  setInterval(scheduleTick, 60_000)
  // sabotagem: checa câmeras tamper_detect+armadas (a cada 20s, alinhado ao sync)
  setInterval(tamperTick, 20_000)
  console.log('[guardian] motor do Modo Guardião iniciado')
}
