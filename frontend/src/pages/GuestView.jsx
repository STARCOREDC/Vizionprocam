// Página PÚBLICA de visualização por convidado (link temporário).
// Não exige login: valida o token em /api/guest/:token, seta o cookie
// vp_guest (usado pelo nginx auth_request pra liberar o /hls) e toca o stream.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import CameraTile from '../components/CameraTile.jsx';

function fmtExpiry(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return '';
  }
}

export default function GuestView() {
  const { token } = useParams();
  const [state, setState] = useState('loading'); // loading | ok | invalid
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/guest/${token}`);
        if (!res.ok) throw new Error('inválido');
        const json = await res.json();
        if (!alive) return;
        // cookie de convidado: o nginx (auth_request) usa ele pra autorizar /hls.
        // SameSite=Lax + path=/ pra valer nas requisições do player.
        document.cookie = `vp_guest=${token}; path=/; max-age=86400; SameSite=Lax`;
        setData(json);
        setState('ok');
      } catch {
        if (alive) setState('invalid');
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  if (state === 'loading') {
    return (
      <div className="guest-screen">
        <div className="guest-card centered-block">
          <div className="spinner" />
          <p>Carregando câmera…</p>
        </div>
      </div>
    );
  }

  if (state === 'invalid') {
    return (
      <div className="guest-screen">
        <div className="guest-card">
          <div className="guest-brand">VizionPro</div>
          <h2>Link expirado ou inválido</h2>
          <p className="guest-sub">
            Este link de compartilhamento não é mais válido. Peça um novo ao
            responsável pela câmera.
          </p>
        </div>
      </div>
    );
  }

  const cam = data.camera || {};
  return (
    <div className="guest-screen">
      <div className="guest-wrap">
        <div className="guest-header">
          <div className="guest-brand">VizionPro</div>
          <span className="guest-badge">Acesso convidado</span>
        </div>

        <div className="guest-player">
          <CameraTile slug={cam.slug} name={cam.name} />
        </div>

        <div className="guest-info">
          <h2>{cam.name || 'Câmera'}</h2>
          {cam.location ? <p className="guest-sub">{cam.location}</p> : null}
          {data.expiresAt ? (
            <p className="guest-expiry">Acesso válido até {fmtExpiry(data.expiresAt)}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
