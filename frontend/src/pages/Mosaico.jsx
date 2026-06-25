import { useEffect, useMemo, useState } from 'react';
import { camerasApi } from '../api.js';
import CameraTile from '../components/CameraTile.jsx';
import Icon from '../components/Icon.jsx';

// Opções de layout: cada uma define quantas colunas o grid usa e
// quantos tiles cabem por "tela" (cols * cols).
const LAYOUTS = [
  { id: 1, label: '1x1', cols: 1 },
  { id: 2, label: '2x2', cols: 2 },
  { id: 3, label: '3x3', cols: 3 },
  { id: 4, label: '4x4', cols: 4 },
];

export default function Mosaico() {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Layout selecionado (2x2 padrão).
  const [cols, setCols] = useState(2);

  // Câmeras selecionadas para exibição (set de ids). null => ainda não inicializado.
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await camerasApi.list();
        if (cancelled) return;
        const cams = Array.isArray(list) ? list : [];
        setCameras(cams);
        // Padrão: todas as câmeras habilitadas.
        const ids = cams
          .filter((c) => c.enabled !== false)
          .map((c) => c.id);
        setSelected(new Set(ids));
      } catch (err) {
        if (!cancelled) setError(err.message || 'Falha ao carregar câmeras.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apenas câmeras habilitadas podem ser exibidas no mosaico.
  const enabledCameras = useMemo(
    () => cameras.filter((c) => c.enabled !== false),
    [cameras]
  );

  const visibleCameras = useMemo(() => {
    if (!selected) return [];
    return enabledCameras.filter((c) => selected.has(c.id));
  }, [enabledCameras, selected]);

  const toggleCamera = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () =>
    setSelected(new Set(enabledCameras.map((c) => c.id)));
  const clearAll = () => setSelected(new Set());

  const selectedCount = selected ? selected.size : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Mosaico</h1>
          <p className="page-sub">Várias câmeras ao vivo na mesma tela</p>
        </div>
        {!loading && !error && enabledCameras.length > 0 && (
          <div className="mosaic-layout-picker" role="group" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`mosaic-layout-btn ${cols === l.cols ? 'active' : ''}`}
                onClick={() => setCols(l.cols)}
                title={`Layout ${l.label}`}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && (
        <div className="centered-block">
          <div className="spinner" />
          <p>Carregando câmeras…</p>
        </div>
      )}

      {!loading && error && <div className="alert error">{error}</div>}

      {!loading && !error && enabledCameras.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon">
            <Icon name="mosaic" size={40} />
          </span>
          <h2>Nenhuma câmera disponível</h2>
          <p>Cadastre e habilite câmeras para montar o mosaico.</p>
        </div>
      )}

      {!loading && !error && enabledCameras.length > 0 && (
        <>
          <div className="alert warn mosaic-warn">
            Exibir muitas câmeras ao vivo pode pesar conforme a conexão/servidor.
          </div>

          {/* Seletor de quais câmeras exibir */}
          <section className="panel mosaic-selector">
            <div className="panel-head-row">
              <h2 className="panel-title" style={{ margin: 0 }}>
                Câmeras exibidas
                <span className="count-pill">{selectedCount}</span>
              </h2>
              <div className="head-actions">
                <button type="button" className="btn ghost" onClick={selectAll}>
                  Todas
                </button>
                <button type="button" className="btn ghost" onClick={clearAll}>
                  Nenhuma
                </button>
              </div>
            </div>
            <div className="mosaic-chips">
              {enabledCameras.map((cam) => {
                const on = selected?.has(cam.id);
                return (
                  <button
                    key={cam.id}
                    type="button"
                    className={`chip ${on ? 'active' : ''}`}
                    onClick={() => toggleCamera(cam.id)}
                  >
                    <span
                      className={`mosaic-chip-dot ${
                        cam.online ? 'on' : 'off'
                      }`}
                      aria-hidden="true"
                    />
                    {cam.name}
                  </button>
                );
              })}
            </div>
          </section>

          {visibleCameras.length === 0 ? (
            <p className="muted">
              Selecione ao menos uma câmera para exibir no mosaico.
            </p>
          ) : (
            <div
              className="mosaic-grid"
              style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
            >
              {visibleCameras.map((cam) => (
                <article className="mosaic-tile" key={cam.id}>
                  <CameraTile slug={cam.slug} name={cam.name} />
                  <div className="mosaic-tile-meta">
                    <span className="mosaic-tile-name">{cam.name}</span>
                    <span
                      className={`status-dot ${cam.online ? 'on' : 'off'}`}
                    >
                      <span className="dot" />
                      {cam.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
