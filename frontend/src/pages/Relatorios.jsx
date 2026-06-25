import { useEffect, useMemo, useState } from 'react';
import { reportsApi } from '../api.js';
import Icon from '../components/Icon.jsx';
import SearchBar from '../components/SearchBar.jsx';
import Pagination from '../components/Pagination.jsx';
import { usePaginated } from '../hooks/usePaginated.js';

const PAGE_SIZE = 20;

// Formata bytes em unidade legível.
function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / Math.pow(1024, i);
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR');
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

export default function Relatorios() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

  const load = async (isRefresh = false) => {
    setError('');
    if (isRefresh) setRefreshing(true);
    try {
      const res = await reportsApi.summary();
      setData(res || null);
    } catch (err) {
      setError(err.message || 'Falha ao carregar relatórios.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const cameras = data?.cameras || {};
  const users = data?.users || {};
  const storage = data?.storage || {};
  const disk = storage.disk || {};

  const diskPct = useMemo(() => {
    const size = Number(disk.size);
    const used = Number(disk.used);
    if (!Number.isFinite(size) || size <= 0) return 0;
    return Math.min(100, Math.round((used / size) * 100));
  }, [disk.size, disk.used]);

  // Filtro da lista de câmeras.
  const camerasList = useMemo(() => {
    const list = Array.isArray(data?.camerasList) ? data.camerasList : [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.slug || '').toLowerCase().includes(q)
    );
  }, [data, query]);

  const { page, setPage, slice } = usePaginated(camerasList, PAGE_SIZE);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Relatórios</h1>
          <p className="page-sub">Visão geral do sistema e armazenamento</p>
        </div>
        <div className="head-actions">
          {data?.generatedAt && (
            <span className="muted gen-stamp">
              gerado às {fmtDateTime(data.generatedAt)}
            </span>
          )}
          <button
            className="btn ghost"
            onClick={() => load(true)}
            disabled={refreshing}
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

      {!loading && !error && data && (
        <>
          {/* Cards de resumo */}
          <section className="stat-grid">
            <StatCard
              icon="camera"
              label="Câmeras"
              value={cameras.total ?? 0}
            />
            <StatCard
              icon="dot"
              label="Online"
              value={cameras.online ?? 0}
              tone="ok"
            />
            <StatCard
              icon="x"
              label="Offline"
              value={cameras.offline ?? 0}
              tone="off"
            />
            <StatCard
              icon="recordings"
              label="Gravando"
              value={cameras.recording ?? 0}
              tone="rec"
            />
            <StatCard icon="user" label="Usuários" value={users.total ?? 0} />
            <StatCard
              icon="group"
              label="Grupos"
              value={data.groups ?? 0}
            />
            <StatCard
              icon="alerts"
              label="Alertas"
              value={data.alerts ?? 0}
              tone="warn"
            />
          </section>

          {/* Armazenamento */}
          <section className="panel">
            <h2 className="panel-title">Armazenamento</h2>
            <div className="storage-grid">
              <div className="storage-disk">
                <div className="storage-disk-head">
                  <span>Disco</span>
                  <span className="muted">
                    {fmtBytes(disk.used)} de {fmtBytes(disk.size)} ({diskPct}%)
                  </span>
                </div>
                <div className="progress">
                  <div
                    className={`progress-fill ${
                      diskPct >= 90 ? 'crit' : diskPct >= 75 ? 'warn' : ''
                    }`}
                    style={{ width: `${diskPct}%` }}
                  />
                </div>
              </div>
              <div className="storage-stats">
                <div className="storage-stat">
                  <span className="storage-stat-label">Gravações</span>
                  <span className="storage-stat-value">
                    {fmtBytes(storage.recordingsBytes)}
                  </span>
                </div>
                <div className="storage-stat">
                  <span className="storage-stat-label">Espaço livre</span>
                  <span className="storage-stat-value">
                    {fmtBytes(disk.avail)}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Tabela de câmeras */}
          <section className="panel">
            <div className="panel-head-row">
              <h2 className="panel-title" style={{ margin: 0 }}>
                Câmeras
                <span className="count-pill">{camerasList.length}</span>
              </h2>
              <SearchBar
                value={query}
                onChange={(v) => {
                  setQuery(v);
                  setPage(1);
                }}
                placeholder="Buscar câmera…"
              />
            </div>

            {camerasList.length === 0 ? (
              <p className="muted">Nenhuma câmera encontrada.</p>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Nome</th>
                        <th>Status</th>
                        <th>Gravando</th>
                        <th>Retenção</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slice.map((cam) => (
                        <tr key={cam.id}>
                          <td data-label="Nome">
                            <span className="cam-name">{cam.name}</span>
                            {cam.slug && (
                              <span className="cam-slug">{cam.slug}</span>
                            )}
                          </td>
                          <td data-label="Status">
                            <span
                              className={`status-dot ${
                                cam.online ? 'on' : 'off'
                              }`}
                            >
                              <span className="dot" />
                              {cam.online ? 'Online' : 'Offline'}
                            </span>
                          </td>
                          <td data-label="Gravando">
                            <span className="bool-flag">
                              {cam.record ? 'Sim' : 'Não'}
                            </span>
                          </td>
                          <td data-label="Retenção">
                            {cam.record_days
                              ? `${cam.record_days} dias`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={page}
                  total={camerasList.length}
                  pageSize={PAGE_SIZE}
                  onChange={setPage}
                />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
