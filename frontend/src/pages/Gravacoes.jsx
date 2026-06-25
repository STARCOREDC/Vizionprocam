import { useEffect, useRef, useState, useCallback } from 'react';
import { camerasApi } from '../api.js';
import Icon from '../components/Icon.jsx';

// Relógio legível a partir de um Date
function fmtClock(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleString('pt-BR');
}

// Date -> string para <input type="date"> (YYYY-MM-DD), em hora local
function toDateInput(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Date -> string para <input type="time"> (HH:MM:SS), em hora local
function toTimeInput(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Duração padrão (segundos) usada no botão "Baixar trecho".
const CLIP_SECONDS = 60;

/**
 * Aba Gravações — estilo DVR.
 * Seletor de câmera + player + régua de linha do tempo arrastável.
 * Arrastando a régua, pede ao Mediamtx o vídeo contínuo a partir daquele instante
 * (/playback/get?start=...), sem precisar baixar arquivo.
 */
export default function Gravacoes() {
  const [cameras, setCameras] = useState([]);
  const [sel, setSel] = useState(null); // câmera selecionada
  const [segments, setSegments] = useState([]);
  const [range, setRange] = useState(null); // { start: Date, end: Date }
  const [playhead, setPlayhead] = useState(null); // Date da posição atual
  const [loading, setLoading] = useState(false);
  const [camsLoading, setCamsLoading] = useState(true);
  const [err, setErr] = useState('');

  // inputs do seletor de data/hora (pulo direto)
  const [jumpDate, setJumpDate] = useState('');
  const [jumpTime, setJumpTime] = useState('');

  const videoRef = useRef(null);
  const loadedRef = useRef({ start: null, dur: 0 });

  // carrega a lista de câmeras
  useEffect(() => {
    camerasApi
      .list()
      .then(setCameras)
      .catch(() => setErr('Falha ao carregar câmeras.'))
      .finally(() => setCamsLoading(false));
  }, []);

  // monta a URL de playback do trecho atual (instante + duração escolhida)
  const playbackUrl = useCallback(
    (t, dur) => {
      const cam = sel;
      if (!cam || !(t instanceof Date)) return null;
      return `/playback/get?path=${encodeURIComponent(cam.slug)}&start=${encodeURIComponent(
        t.toISOString()
      )}&duration=${dur}&format=mp4`;
    },
    [sel]
  );

  // monta a URL de playback e carrega no player
  const loadAt = useCallback(
    (t, rng) => {
      const cam = sel;
      const r = rng || range;
      if (!cam || !r) return;
      let dur = Math.floor((r.end.getTime() - t.getTime()) / 1000);
      if (dur < 2) dur = 2;
      if (dur > 3600) dur = 3600; // pede no máx 1h por vez (timeline cobre o resto)
      const url = `/playback/get?path=${encodeURIComponent(cam.slug)}&start=${encodeURIComponent(
        t.toISOString()
      )}&duration=${dur}&format=mp4`;
      loadedRef.current = { start: t, dur };
      setPlayhead(t);
      // sincroniza os inputs de data/hora com o ponto carregado
      setJumpDate(toDateInput(t));
      setJumpTime(toTimeInput(t));
      const v = videoRef.current;
      if (v) {
        v.src = url;
        v.load();
        v.play().catch(() => {});
      }
    },
    [sel, range]
  );

  // ao trocar de câmera, busca as gravações e calcula o intervalo gravado
  useEffect(() => {
    if (!sel) return;
    setLoading(true);
    setErr('');
    setSegments([]);
    setRange(null);
    setPlayhead(null);
    camerasApi
      .recordings(sel.id)
      .then((segs) => {
        const list = Array.isArray(segs) ? segs : [];
        setSegments(list);
        if (list.length) {
          const starts = list.map((s) => new Date(s.start).getTime());
          const ends = list.map((s) => new Date(s.start).getTime() + (s.durationSec || 0) * 1000);
          const rs = new Date(Math.min(...starts));
          const re = new Date(Math.max(...ends));
          const rng = { start: rs, end: re };
          setRange(rng);
          const startAt = new Date(Math.max(rs.getTime(), re.getTime() - 30000));
          loadAt(startAt, rng);
        }
      })
      .catch(() => setErr('Falha ao carregar gravações.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  function onTime() {
    const v = videoRef.current;
    if (!v || !loadedRef.current.start) return;
    setPlayhead(new Date(loadedRef.current.start.getTime() + v.currentTime * 1000));
  }

  function onEnded() {
    if (!loadedRef.current.start || !range) return;
    const next = new Date(loadedRef.current.start.getTime() + (loadedRef.current.dur || 0) * 1000);
    if (next < range.end) loadAt(next);
  }

  function seekFromClientX(clientX, el) {
    if (!range) return;
    const r = el.getBoundingClientRect();
    let frac = (clientX - r.left) / r.width;
    frac = Math.max(0, Math.min(1, frac));
    const t = new Date(range.start.getTime() + frac * (range.end.getTime() - range.start.getTime()));
    loadAt(t);
  }

  function jump(deltaSec) {
    if (!playhead || !range) return;
    let t = new Date(playhead.getTime() + deltaSec * 1000);
    if (t < range.start) t = range.start;
    if (t > range.end) t = new Date(range.end.getTime() - 2000);
    loadAt(t);
  }

  // pula direto pro instante escolhido nos inputs de data/hora
  function jumpToPicked() {
    if (!range) return;
    if (!jumpDate) {
      setErr('Escolha uma data para pular.');
      return;
    }
    const time = jumpTime || '00:00:00';
    const t = new Date(`${jumpDate}T${time}`);
    if (Number.isNaN(t.getTime())) {
      setErr('Data/hora inválida.');
      return;
    }
    let target = t;
    if (target < range.start) target = range.start;
    if (target > range.end) target = new Date(range.end.getTime() - 2000);
    setErr('');
    loadAt(target);
  }

  const frac =
    range && playhead
      ? (playhead.getTime() - range.start.getTime()) /
        (range.end.getTime() - range.start.getTime())
      : 0;

  // URL do trecho atual pra download (instante atual + CLIP_SECONDS, limitado ao fim)
  let clipUrl = null;
  let clipName = '';
  if (sel && playhead && range) {
    let dur = Math.floor((range.end.getTime() - playhead.getTime()) / 1000);
    if (dur < 2) dur = 2;
    if (dur > CLIP_SECONDS) dur = CLIP_SECONDS;
    clipUrl = playbackUrl(playhead, dur);
    const stamp = toDateInput(playhead) + '_' + toTimeInput(playhead).replace(/:/g, '-');
    clipName = `${sel.slug}_${stamp}.mp4`;
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Gravações</h1>
          <p className="page-sub">
            Linha do tempo estilo DVR — arraste para assistir qualquer momento.
          </p>
        </div>
      </div>

      {err && !sel && <div className="alert error" style={{ marginBottom: 16 }}>{err}</div>}

      {/* Seletor de câmera */}
      {camsLoading ? (
        <div className="centered-block">
          <div className="spinner" />
        </div>
      ) : cameras.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <Icon name="camera" size={42} />
          </span>
          <h2>Nenhuma câmera cadastrada</h2>
          <p>Cadastre câmeras para visualizar as gravações.</p>
        </div>
      ) : (
        <div className="dvr-cams">
          {cameras.map((c) => (
            <button
              key={c.id}
              className={`chip ${sel && sel.id === c.id ? 'active' : ''}`}
              onClick={() => setSel(c)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {!sel && cameras.length > 0 && !camsLoading && (
        <p className="muted">Selecione uma câmera acima para começar.</p>
      )}

      {sel && (
        <div className="dvr-wrap">
          {sel.record === false && (
            <div className="alert warn">
              Gravação desligada nesta câmera. Ligue em <strong>Câmeras</strong> para gravar.
            </div>
          )}

          <div className="dvr-player">
            <video
              ref={videoRef}
              className="dvr-video"
              controls
              muted
              playsInline
              onTimeUpdate={onTime}
              onEnded={onEnded}
            />
          </div>

          {/* Barra de controles: relógio + saltos rápidos + baixar */}
          <div className="dvr-bar">
            <div className="dvr-clock">
              <Icon
                name="dot"
                size={14}
                style={{ color: 'var(--danger)', marginRight: 6 }}
              />
              {fmtClock(playhead)}
            </div>
            <div className="dvr-quick">
              <button className="btn ghost sm" onClick={() => jump(-3600)} disabled={!range}>
                −1h
              </button>
              <button className="btn ghost sm" onClick={() => jump(-600)} disabled={!range}>
                −10min
              </button>
              <button className="btn ghost sm" onClick={() => jump(-60)} disabled={!range}>
                −1min
              </button>
              <button className="btn ghost sm" onClick={() => jump(60)} disabled={!range}>
                +1min
              </button>
              <button
                className="btn ghost sm"
                onClick={() => range && loadAt(range.start)}
                disabled={!range}
              >
                Início
              </button>
              <button
                className="btn ghost sm"
                onClick={() => range && loadAt(new Date(range.end.getTime() - 30000))}
                disabled={!range}
              >
                Mais recente
              </button>
              {clipUrl ? (
                <a
                  className="btn primary sm"
                  href={clipUrl}
                  download={clipName}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  title={`Baixa ${CLIP_SECONDS}s a partir do ponto atual`}
                >
                  <Icon name="play" size={14} />
                  Baixar trecho ({CLIP_SECONDS}s)
                </a>
              ) : (
                <button className="btn primary sm" disabled>
                  Baixar trecho ({CLIP_SECONDS}s)
                </button>
              )}
            </div>
          </div>

          {/* Seletor de data/hora — pular direto pra um momento exato */}
          {range && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                gap: 12,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '14px 16px',
              }}
            >
              <label className="field" style={{ flex: '0 0 auto' }}>
                <span>Ir para a data</span>
                <input
                  type="date"
                  value={jumpDate}
                  min={toDateInput(range.start)}
                  max={toDateInput(range.end)}
                  onChange={(e) => setJumpDate(e.target.value)}
                  style={{ colorScheme: 'dark' }}
                />
              </label>
              <label className="field" style={{ flex: '0 0 auto' }}>
                <span>Hora</span>
                <input
                  type="time"
                  step="1"
                  value={jumpTime}
                  onChange={(e) => setJumpTime(e.target.value)}
                  style={{ colorScheme: 'dark' }}
                />
              </label>
              <button
                className="btn primary"
                onClick={jumpToPicked}
                style={{ marginBottom: 1 }}
              >
                Ir para o momento
              </button>
              <span className="field-hint" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
                Gravado de {fmtClock(range.start)} até {fmtClock(range.end)}
              </span>
            </div>
          )}

          {/* Linha do tempo arrastável (lógica de scrub preservada) */}
          {range && (
            <>
              <div
                className="dvr-timeline"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  seekFromClientX(e.clientX, e.currentTarget);
                }}
                onPointerMove={(e) => {
                  if (e.buttons === 1) seekFromClientX(e.clientX, e.currentTarget);
                }}
              >
                {segments.map((s, i) => {
                  const st = new Date(s.start).getTime();
                  const en = st + (s.durationSec || 0) * 1000;
                  const total = range.end.getTime() - range.start.getTime() || 1;
                  const left = ((st - range.start.getTime()) / total) * 100;
                  const w = ((en - st) / total) * 100;
                  return (
                    <div key={i} className="dvr-seg" style={{ left: `${left}%`, width: `${w}%` }} />
                  );
                })}
                <div className="dvr-playhead" style={{ left: `${frac * 100}%` }} />
              </div>
              <div className="dvr-range-labels">
                <span>{fmtClock(range.start)}</span>
                <span>{fmtClock(range.end)}</span>
              </div>
            </>
          )}

          {loading && (
            <div className="centered-block" style={{ padding: '24px 0' }}>
              <div className="spinner" />
            </div>
          )}
          {!loading && segments.length === 0 && !err && (
            <div className="empty-state" style={{ padding: '40px 20px' }}>
              <span className="empty-icon">
                <Icon name="recordings" size={38} />
              </span>
              <h2>Sem gravações</h2>
              <p>Esta câmera ainda não tem nenhuma gravação disponível.</p>
            </div>
          )}
          {err && <div className="alert error">{err}</div>}
        </div>
      )}
    </div>
  );
}
