import { useEffect, useRef, useState } from 'react';
import { reportsApi } from '../api.js';
import Icon from '../components/Icon.jsx';

const REFRESH_MS = 5000;

// Bytes -> GB com 1 casa.
function gb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return (n / Math.pow(1024, 3)).toFixed(1);
}

// Segundos -> "Xd Yh Zmin" (omite zeros à esquerda).
function fmtUptime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (parts.length < 2) parts.push(`${m}min`);
  return parts.join(' ');
}

// Tom de barra: verde <70, amarelo 70-90, vermelho >90.
function barTone(pct) {
  if (pct > 90) return 'crit';
  if (pct >= 70) return 'warn';
  return '';
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function GaugeCard({ title, pct, detail }) {
  const p = clampPct(pct);
  return (
    <div className="panel sys-card">
      <div className="sys-card-head">
        <span className="sys-card-title">{title}</span>
        <span className="sys-card-pct">{p}%</span>
      </div>
      <div className="progress">
        <div
          className={`progress-fill ${barTone(p)}`}
          style={{ width: `${p}%` }}
        />
      </div>
      {detail && <div className="sys-card-detail muted">{detail}</div>}
    </div>
  );
}

function ValueCard({ icon, title, value, detail, tone = '' }) {
  return (
    <div className={`panel sys-card sys-card-value ${tone}`}>
      <span className="stat-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <div className="stat-body">
        <span className="stat-value">{value}</span>
        <span className="stat-label">{title}</span>
        {detail && <span className="sys-card-detail muted">{detail}</span>}
      </div>
    </div>
  );
}

export default function Sistema() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const timerRef = useRef(null);

  const load = async () => {
    try {
      const res = await reportsApi.system();
      setData(res || null);
      setError('');
    } catch (err) {
      setError(err.message || 'Falha ao carregar status do sistema.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (paused) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    timerRef.current = setInterval(load, REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [paused]);

  const cpu = data?.cpu || {};
  const ram = data?.ram || {};
  const disk = data?.disk || {};
  const root = disk.root || {};
  const recordings = disk.recordings || {};
  const mediamtx = data?.mediamtx || {};
  const db = data?.db || {};
  const processes = data?.processes || {};

  // % de disco a partir de used/size.
  const diskPct = (d) => {
    const size = Number(d.size);
    const used = Number(d.used);
    if (!Number.isFinite(size) || size <= 0) return 0;
    return (used / size) * 100;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Status do sistema</h1>
          <p className="page-sub">
            Saúde do servidor e serviços em tempo real
          </p>
        </div>
        <div className="head-actions">
          <span className={`live-pill ${paused ? 'off' : ''}`}>
            <span className="dot" />
            {paused ? 'Pausado' : 'Ao vivo'}
          </span>
          <button
            className="btn ghost"
            onClick={() => {
              if (paused) {
                setPaused(false);
                load();
              } else {
                setPaused(true);
              }
            }}
          >
            {paused ? 'Retomar' : 'Pausar'}
          </button>
        </div>
      </div>

      {loading && (
        <div className="centered-block">
          <div className="spinner" />
        </div>
      )}

      {!loading && error && <div className="alert error">{error}</div>}

      {!loading && data && (
        <>
          {error && <div className="alert error">{error}</div>}

          <section className="sys-grid">
            <GaugeCard
              title="CPU"
              pct={cpu.loadPct}
              detail={`load ${Number(cpu.load1 ?? 0).toFixed(2)} · ${
                cpu.cores ?? '?'
              } núcleos`}
            />
            <GaugeCard
              title="Memória RAM"
              pct={ram.usedPct}
              detail={`${gb(ram.used)} GB de ${gb(ram.total)} GB`}
            />
            <GaugeCard
              title="Disco raiz"
              pct={diskPct(root)}
              detail={`${gb(root.used)} GB usados · ${gb(
                root.avail
              )} GB livres`}
            />
            <GaugeCard
              title="Disco de gravações"
              pct={diskPct(recordings)}
              detail={`${gb(recordings.used)} GB usados · ${gb(
                recordings.avail
              )} GB livres`}
            />

            <ValueCard
              icon="settings"
              title="Uptime do servidor"
              value={fmtUptime(data.uptimeSec)}
            />
            <ValueCard
              icon="activity"
              title="Uptime do serviço"
              value={fmtUptime(data.serviceUptimeSec)}
            />
            <ValueCard
              icon="recordings"
              title="ffmpeg ativos"
              value={processes.ffmpeg ?? 0}
              detail="processos de gravação"
            />
            <ValueCard
              icon="server"
              title="MediaMTX"
              value={mediamtx.ok ? 'OK' : 'Falha'}
              detail={`${mediamtx.pathsReady ?? 0}/${
                mediamtx.pathsTotal ?? 0
              } streams prontos`}
              tone={mediamtx.ok ? 'ok' : 'crit'}
            />
            <ValueCard
              icon="database"
              title="Banco de dados"
              value={db.ok ? 'OK' : 'Falha'}
              detail={db.ok ? `ping ${db.pingMs ?? '?'} ms` : 'sem resposta'}
              tone={db.ok ? 'ok' : 'crit'}
            />
          </section>

          {data.generatedAt && (
            <p className="muted gen-stamp">
              atualizado às{' '}
              {new Date(data.generatedAt).toLocaleTimeString('pt-BR')}
            </p>
          )}
        </>
      )}
    </>
  );
}
