import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { camerasApi } from '../api.js';
import CameraTile from '../components/CameraTile.jsx';

// Página "Ao vivo": grid de câmeras com player HLS.
export default function Dashboard() {
  const { isAdmin } = useAuth();
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await camerasApi.list();
        if (!cancelled) setCameras(Array.isArray(list) ? list : []);
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

  // Viewer já recebe só as habilitadas; admin filtramos no cliente.
  const enabledCameras = cameras.filter((c) => c.enabled !== false);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Ao vivo</h1>
          <p className="page-sub">Monitoramento em tempo real</p>
        </div>
        {isAdmin && !loading && !error && (
          <div className="mini-stats">
            <span className="mini-stat">
              <strong>{enabledCameras.length}</strong> ativas
            </span>
            <span className="mini-stat dim">
              <strong>{cameras.length}</strong> no total
            </span>
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
          <div className="empty-icon">📷</div>
          <h2>Nenhuma câmera disponível</h2>
          <p>
            {isAdmin
              ? 'Adicione câmeras na área de gerenciamento.'
              : 'Peça a um administrador para liberar câmeras para você.'}
          </p>
          {isAdmin && (
            <Link to="/cameras" className="btn primary">
              Adicionar câmera
            </Link>
          )}
        </div>
      )}

      {!loading && !error && enabledCameras.length > 0 && (
        <div className="camera-grid">
          {enabledCameras.map((cam) => (
            <article className="camera-card" key={cam.id}>
              <CameraTile slug={cam.slug} name={cam.name} />
              <div className="camera-meta">
                <h3 className="camera-name">{cam.name}</h3>
                {cam.location && (
                  <p className="camera-location">
                    <span aria-hidden="true">📍</span> {cam.location}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
