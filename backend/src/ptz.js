// Controle PTZ (mover + presets) via ONVIF. Compartilhado entre a rota de
// câmeras (controle manual no app) e o monitor de saúde (auto-retorno ao
// preset "home" quando a câmera reconecta — câmeras PT voltam pro padrão de
// fábrica ao reiniciar, então mandamos elas de volta pro ângulo salvo).
import onvif from 'onvif'

const { Cam } = onvif

// Extrai ip/usuário/senha do RTSP. Lida com o formato padrão (user:pass@host)
// e com o formato XM/iCSee (user=admin_password=xxx no caminho).
export function camCreds(rtsp) {
  const s = String(rtsp || '')
  const ip = (s.match(/rtsp:\/\/(?:[^@/]*@)?([^/:?]+)/i) || [])[1] || null
  let username = ''
  let password = ''
  const xm = s.match(/user=([^_]+)_password=([^_&/]+)/i)
  if (xm) {
    username = xm[1]
    password = xm[2]
  } else {
    const std = s.match(/rtsp:\/\/([^:@/]+):([^@/]+)@/i)
    if (std) {
      try {
        username = decodeURIComponent(std[1])
        password = decodeURIComponent(std[2])
      } catch {
        username = std[1]
        password = std[2]
      }
    }
  }
  return { ip, username, password }
}

function camCall(fn, cam, arg) {
  return new Promise((resolve, reject) => {
    fn.call(cam, arg, (err, res) => (err ? reject(err) : resolve(res)))
  })
}

// Conecta no ONVIF de uma câmera (row com rtsp_url e onvif_port).
function connectCamera(cam) {
  const { ip, username, password } = camCreds(cam.rtsp_url)
  if (!ip) return Promise.reject(new Error('IP da câmera não encontrado'))
  return new Promise((resolve, reject) => {
    const c = new Cam(
      { hostname: ip, username, password, port: cam.onvif_port || 8899, timeout: 6000 },
      (err) => (err ? reject(err) : resolve(c))
    )
  })
}

// Token do primeiro preset salvo (o "home"), ou null se não há nenhum.
// A câmera XM atribui o token sozinha (ex: 0) — não dá pra assumir '1'.
function firstPresetToken(presets) {
  const list = Object.values(presets || {})
  if (!list.length) return null
  const p = list[0]
  const t = p?.$?.token ?? p?.token
  return t === undefined ? null : t
}

// Move a câmera pro preset "home" (o primeiro preset salvo).
export async function ptzGotoHome(cam) {
  const c = await connectCamera(cam)
  const presets = await camCall(c.getPresets, c, {})
  const token = firstPresetToken(presets)
  if (token === null) throw new Error('Nenhum preset salvo')
  await camCall(c.gotoPreset, c, { preset: String(token) })
  return token
}

// Salva a posição atual como "home". Sobrescreve o preset existente (mesmo
// token) pra não acumular presets a cada toque no botão.
export async function ptzSetHome(cam) {
  const c = await connectCamera(cam)
  const presets = await camCall(c.getPresets, c, {})
  const token = firstPresetToken(presets)
  const arg = { presetName: 'home' }
  if (token !== null) arg.presetToken = String(token)
  await camCall(c.setPreset, c, arg)
  return token
}

const SPEED = 0.6
const DIRS = {
  up: { x: 0, y: SPEED },
  down: { x: 0, y: -SPEED },
  left: { x: -SPEED, y: 0 },
  right: { x: SPEED, y: 0 },
}

// Movimento contínuo numa direção (segurar) — pare com ptzStop.
export async function ptzMove(cam, dir) {
  const v = DIRS[dir]
  if (!v) throw new Error('Direção inválida')
  const c = await connectCamera(cam)
  await camCall(c.continuousMove, c, { x: v.x, y: v.y, zoom: 0 })
}

export async function ptzStop(cam) {
  const c = await connectCamera(cam)
  await camCall(c.stop, c, { panTilt: true, zoom: true })
}
