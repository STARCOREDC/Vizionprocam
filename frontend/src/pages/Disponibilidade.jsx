import { useEffect, useMemo, useState } from 'react';
import { reportsApi } from '../api.js';
import Icon from '../components/Icon.jsx';

const PERIODS = [7, 30, 90];

// Formata segundos como "Xh Ymin" ou "Ymin".
function fmtDowntime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '0min';
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

// Classe de tom conforme uptime: verde >=99, amarelo 95-99, vermelho <95.
function uptimeTone(pct) {
  if (pct >= 99) return 'ok';
  if (pct >= 95) return 'warn';
  return 'crit';
}

function StatCard({ icon, label, value, tone = '' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <span className="stat-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <div className="stat-body">
        <span className="stat-value">{value}</span>
        <span className="stat-label">{label}</span>
      </div>
    </div>
  );
}

export default function Disponibilidade() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = async (period, isRefresh = false) => {
    setError('');
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await reportsApi.uptime(period);
      setRows(Array.isArray(res) ? res : []);
    } catch (err) {
      setError(err.message || 'Falha ao carregar disponibilidade.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load(days, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const summary = useMemo(() => {
    const monitored = rows.filter((r) => r.monitored);
    const avgUptime =
      monitored.length > 0
        ? monitored.reduce((s, r) => s + Number(r.uptimePct || 0), 0) /
          monitored.length
        : null;
    const totalOutages = rows.reduce((s, r) => s + Number(r.outages || 0), 0);
    // Lista já vem ordenada piores primeiro; o pior monitorado é o primeiro monitored.
    const worst = monitored.length > 0 ? monitored[0] : null;
    return { avgUptime, totalOutages, worst, monitoredCount: monitored.length };
  }, [rows]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Disponibilidade das câmeras</h1>
          <p className="page-sub">Histórico de uptime (SLA) por câmera</p>
        </div>
        <div className="head-actions">
          <div className="filter-tabs" role="tablist" aria-label="Período">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={days === p}
                className={`filter-tab ${days === p ? 'active' : ''}`}
                onClick={() => setDays(p)}
                disabled={loading || refreshing}
              >
                {p} dias
              </button>
            ))}
          </div>
          <button
            className="btn ghost"
            onClick={() => load(days, true)}
            disabled={refreshing || loading}
          >
            {refreshing ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      {loading && (
        <div className="centered-block">
          <div className="spinner" />
        </div>
      )}

      {!loading && error && <div className="alert error">{error}</div>}

      {!loading && !error && rows.length === 0 && (
        <p className="muted">Nenhuma câmera encontrada.</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <section className="stat-grid">
            <StatCard
              icon="activity"
              label="Uptime médio (monitoradas)"
              value={
                summary.avgUptime != null
                  ? `${summary.avgUptime.toFixed(2)}%`
                  : '—'
              }
              tone={
                summary.avgUptime != null
                  ? uptimeTone(summary.avgUptime) === 'ok'
                    ? 'ok'
                    : uptimeTone(summary.avgUptime) === 'warn'
                    ? 'warn'
                    : 'rec'
                  : ''
              }
            />
            <StatCard
              icon="x"
              label="Total de quedas"
              value={summary.totalOutages}
              tone={summary.totalOutages > 0 ? 'warn' : 'ok'}
            />
            <StatCard
              icon="alerts"
              label="Pior uptime"
              value={
                summary.worst
                  ? `${Number(summary.worst.uptimePct).toFixed(2)}%`
                  : '—'
              }
              tone="rec"
            />
          </section>

          <section className="panel">
            <h2 className="panel-title">
              Por câmera
              <span className="count-pill">{rows.length}</span>
            </h2>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Câmera</th>
                    <th>Uptime</th>
                    <th>Quedas</th>
                    <th>Tempo fora</th>
                    <th>Janela</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pct = Number(r.uptimePct);
                    const tone = r.monitored ? uptimeTone(pct) : '';
                    return (
                      <tr key={r.camera_id}>
                        <td data-label="Câmera">
                          <span className="cam-name">{r.name}</span>
                          {r.slug && (
                            <span className="cam-slug">{r.slug}</span>
                          )}
                        </td>
                        <td data-label="Uptime">
                          {r.monitored ? (
                            <div className="uptime-cell">
                              <div className="uptime-bar">
                                <div
                                  className={`uptime-bar-fill ${tone}`}
                                  style={{
                                    width: `${Math.max(
                                      0,
                                      Math.min(100, pct)
                                    )}%`,
                                  }}
                                />
                              </div>
                              <span className="uptime-pct">
                                {pct.toFixed(2)}%
                              </span>
                            </div>
                          ) : (
                            <span className="badge badge-muted">
                              Sem gravação
                            </span>
                          )}
                        </td>
                        <td data-label="Quedas">
                          {r.monitored ? r.outages ?? 0 : '—'}
                        </td>
                        <td data-label="Tempo fora">
                          {r.monitored ? fmtDowntime(r.downtimeSec) : '—'}
                        </td>
                        <td data-label="Janela">
                          {r.windowDays ? `${r.windowDays} dias` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
