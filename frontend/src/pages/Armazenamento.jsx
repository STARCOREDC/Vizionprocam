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

function gb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return (n / Math.pow(1024, 3)).toFixed(1);
}

export default function Armazenamento() {
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
      setError(err.message || 'Falha ao carregar armazenamento.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const storage = data?.storage || {};
  const disk = storage.disk || {};

  const diskPct = useMemo(() => {
    const size = Number(disk.size);
    const used = Number(disk.used);
    if (!Number.isFinite(size) || size <= 0) return 0;
    return Math.min(100, Math.round((used / size) * 100));
  }, [disk.size, disk.used]);

  const diskTone = diskPct >= 85 ? 'crit' : diskPct >= 70 ? 'warn' : '';

  // Lista de câmeras filtrada + ordenada por tamanho gravado desc.
  const camerasList = useMemo(() => {
    const list = Array.isArray(data?.camerasList) ? data.camerasList : [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (c) =>
            (c.name || '').toLowerCase().includes(q) ||
            (c.slug || '').toLowerCase().includes(q)
        )
      : list;
    return [...filtered].sort(
      (a, b) => Number(b.recordingsBytes || 0) - Number(a.recordingsBytes || 0)
    );
  }, [data, query]);

  const { page, setPage, slice } = usePaginated(camerasList, PAGE_SIZE);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Armazenamento</h1>
          <p className="page-sub">Uso de disco e gravações por câmera</p>
        </div>
        <div className="head-actions">
          <button
            className="btn ghost"
            onClick={() => load(true)}
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

      {!loading && !error && data && (
        <>
          {/* Cards principais */}
          <section className="storage-cards">
            <div className="panel storage-disk-card">
              <div className="storage-disk-head">
                <span>Disco</span>
                <span className="muted">{diskPct}% usado</span>
              </div>
              <div className="progress">
                <div
                  className={`progress-fill ${diskTone}`}
                  style={{ width: `${diskPct}%` }}
                />
              </div>
              <div className="storage-disk-figures">
                <span>
                  <strong>{gb(disk.used)} GB</strong> usados de{' '}
                  <strong>{gb(disk.size)} GB</strong>
                </span>
                <span className="muted">{gb(disk.avail)} GB livres</span>
              </div>
            </div>

            <div className="panel storage-rec-card">
              <span className="stat-icon" aria-hidden="true">
                <Icon name="recordings" size={22} />
              </span>
              <div className="stat-body">
                <span className="stat-value">
                  {fmtBytes(storage.recordingsBytes)}
                </span>
                <span className="stat-label">Gravações ocupam</span>
              </div>
            </div>
          </section>

          {/* Tabela por câmera */}
          <section className="panel">
            <div className="panel-head-row">
              <h2 className="panel-title" style={{ margin: 0 }}>
                Por câmera
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
                        <th>Tamanho gravado</th>
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
                          <td data-label="Tamanho gravado">
                            {fmtBytes(cam.recordingsBytes)}
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

          <div className="alert warn">
            As gravações são rotacionadas automaticamente conforme a retenção de
            cada câmera.
            {diskPct >= 70 &&
              ' O disco está enchendo — considere aumentar o armazenamento ou reduzir a retenção das câmeras.'}
          </div>
        </>
      )}
    </>
  );
}
