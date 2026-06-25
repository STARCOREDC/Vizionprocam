import onvif from 'onvif'

const { Cam } = onvif

// injeta usuário:senha na URL RTSP que o ONVIF devolve (geralmente vem sem credenciais)
function injectCreds(uri, username, password) {
  if (!uri) return uri
  if (!username) return uri
  const m = uri.match(/^(rtsp:\/\/)(.*)$/i)
  if (!m) return uri
  const cred = `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@`
  return `${m[1]}${cred}${m[2]}`
}

// Conecta no ONVIF da câmera e descobre a(s) URL(s) RTSP.
// Retorna { ok, streams: [{ name, uri }] } ou lança erro.
export function onvifDetect({ ip, port, username, password }) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn, arg) => {
      if (done) return
      done = true
      fn(arg)
    }
    const cam = new Cam(
      {
        hostname: ip,
        username: username || '',
        password: password || '',
        port: Number(port) || 80,
        timeout: 9000,
      },
      function (err) {
        if (err) return finish(reject, err)
        const profiles = cam.profiles || []
        const streams = []
        let pending = profiles.length || 0
        if (!pending) {
          // sem profiles listados: tenta o stream default
          cam.getStreamUri({ protocol: 'RTSP' }, (e2, s) => {
            if (e2 || !s?.uri) return finish(reject, e2 || new Error('sem stream'))
            finish(resolve, {
              ok: true,
              streams: [{ name: 'Principal', uri: injectCreds(s.uri, username, password) }],
            })
          })
          return
        }
        profiles.forEach((p, i) => {
          const token = p.$ ? p.$.token : p.token
          cam.getStreamUri({ protocol: 'RTSP', profileToken: token }, (e2, s) => {
            if (!e2 && s?.uri) {
              streams.push({
                name: p.name || `Stream ${i + 1}`,
                uri: injectCreds(s.uri, username, password),
              })
            }
            pending -= 1
            if (pending === 0) {
              if (!streams.length) return finish(reject, new Error('nenhum stream RTSP'))
              finish(resolve, { ok: true, streams })
            }
          })
        })
      }
    )
    // timeout de segurança
    setTimeout(() => finish(reject, new Error('timeout ONVIF')), 11000)
  })
}

// Verifica via ONVIF se a câmera expõe saída de áudio (talk / áudio bidirecional).
// NUNCA lança nem rejeita: qualquer falha (sem conexão, sem método, timeout)
// resolve { supported: false, reason } — a rota nunca deve responder 500.
// OBS: a transmissão de voz em si (backchannel RTSP) será implementada quando
// houver uma câmera compatível disponível pra teste — aqui é só a checagem.
export function talkCapability({ ip, port, username, password }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    const unsupported = () =>
      finish({ supported: false, reason: 'A câmera não expõe áudio bidirecional (ONVIF).' })
    try {
      const cam = new Cam(
        {
          hostname: ip,
          username: username || '',
          password: password || '',
          port: Number(port) || 8899,
          timeout: 8000,
        },
        function (err) {
          if (err) return unsupported()
          // nem toda câmera (nem toda versão da lib) tem getAudioOutputs
          if (typeof cam.getAudioOutputs !== 'function') return unsupported()
          try {
            cam.getAudioOutputs((e2, outputs) => {
              if (!e2 && outputs && outputs.length > 0) return finish({ supported: true })
              unsupported()
            })
          } catch {
            unsupported()
          }
        }
      )
      // erros assíncronos da lib (socket caiu etc.)
      if (typeof cam.on === 'function') cam.on('error', unsupported)
    } catch {
      unsupported()
    }
    // timeout de segurança (8s de conexão + folga pra chamada de capability)
    setTimeout(unsupported, 10000)
  })
}
