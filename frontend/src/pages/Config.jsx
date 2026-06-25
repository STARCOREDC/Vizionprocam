import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { authApi, reportsApi } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Icon from '../components/Icon.jsx';

const APP_VERSION = '1.0.0';

// Formata bytes em unidade legível.
function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / Math.pow(1024, i);
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Iniciais a partir do username (até 2 letras).
function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name).slice(0, 2).toUpperCase();
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

export default function Config() {
  const toast = useToast();
  const { user } = useAuth();

  // --- Trocar senha --------------------------------------------------------
  const [showPwd, setShowPwd] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdOk, setPwdOk] = useState('');
  const [saving, setSaving] = useState(false);

  // --- Visão geral do sistema ---------------------------------------------
  const [summary, setSummary] = useState(null);
  const [sumLoading, setSumLoading] = useState(true);
  const [sumError, setSumError] = useState('');

  useEffect(() => {
    let cancelled = false;
    reportsApi
      .summary()
      .then((res) => {
        if (!cancelled) setSummary(res || null);
      })
      .catch((err) => {
        if (!cancelled) setSumError(err.message || 'Falha ao carregar o resumo do sistema.');
      })
      .finally(() => {
        if (!cancelled) setSumLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cameras = summary?.cameras || {};
  const users = summary?.users || {};
  const storage = summary?.storage || {};
  const disk = storage.disk || {};

  const diskPct = useMemo(() => {
    const size = Number(disk.size);
    const used = Number(disk.used);
    if (!Number.isFinite(size) || size <= 0) return 0;
    return Math.min(100, Math.round((used / size) * 100));
  }, [disk.size, disk.used]);

  const resetPwd = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setPwdError('');
    setPwdOk('');
  };

  const onChangePassword = async (e) => {
    e.preventDefault();
    setPwdError('');
    setPwdOk('');

    if (!current) {
      setPwdError('Informe sua senha atual.');
      return;
    }
    if (!next || next.length < 4) {
      setPwdError('A nova senha deve ter ao menos 4 caracteres.');
      return;
    }
    if (next !== confirm) {
      setPwdError('A confirmação não confere com a nova senha.');
      return;
    }

    setSaving(true);
    try {
      await authApi.changePassword(current, next);
      resetPwd();
      setShowPwd(false);
      setPwdOk('Senha alterada com sucesso.');
      toast.success('Senha alterada com sucesso.');
    } catch (err) {
      setPwdError(err.message || 'Não foi possível alterar a senha.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Configurações</h1>
          <p className="page-sub">Sua conta, o sistema e as políticas do VizionPro</p>
        </div>
      </div>

      {/* === 1. Perfil ====================================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="user" size={18} /> Perfil
        </h2>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              background: 'var(--accent-soft)',
              color: '#cfe0ff',
              fontWeight: 700,
              fontSize: '1.5rem',
              flexShrink: 0,
            }}
          >
            {initials(user?.username)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: '1.15rem', fontWeight: 700 }}>
              {user?.username || '—'}
            </span>
            <span
              className={`role-pill ${user?.role === 'admin' ? 'admin' : 'viewer'}`}
              style={{ alignSelf: 'flex-start' }}
            >
              {user?.role || '—'}
            </span>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            {!showPwd && (
              <button
                className="btn ghost"
                onClick={() => {
                  resetPwd();
                  setShowPwd(true);
                }}
              >
                Trocar senha
              </button>
            )}
          </div>
        </div>

        {pwdOk && !showPwd && (
          <div className="alert info" style={{ marginTop: 16 }}>
            {pwdOk}
          </div>
        )}

        {showPwd && (
          <form
            className="camera-form"
            onSubmit={onChangePassword}
            style={{ marginTop: 20, maxWidth: 460 }}
          >
            <label className="field">
              <span>Senha atual</span>
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="field">
              <span>Nova senha</span>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="field">
              <span>Confirmar nova senha</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>

            {pwdError && <div className="alert error">{pwdError}</div>}

            <div className="form-actions" style={{ gap: 10 }}>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  resetPwd();
                  setShowPwd(false);
                }}
                disabled={saving}
              >
                Cancelar
              </button>
              <button className="btn primary" disabled={saving}>
                {saving ? 'Salvando…' : 'Alterar senha'}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* === 2. Visão geral do sistema ===================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="dashboard" size={18} /> Visão geral do sistema
        </h2>

        {sumLoading ? (
          <div className="centered-block" style={{ padding: '24px 0' }}>
            <div className="spinner" />
          </div>
        ) : sumError ? (
          <div className="alert error">{sumError}</div>
        ) : (
          <>
            <div className="stat-grid">
              <StatCard icon="camera" label="Câmeras" value={cameras.total ?? 0} />
              <StatCard
                icon="dot"
                label="Online"
                value={cameras.online ?? 0}
                tone="ok"
              />
              <StatCard
                icon="recordings"
                label="Gravando"
                value={cameras.recording ?? 0}
                tone="rec"
              />
              <StatCard icon="user" label="Usuários" value={users.total ?? 0} />
              <StatCard icon="group" label="Grupos" value={summary?.groups ?? 0} />
              <StatCard
                icon="reports"
                label="Gravado (em disco)"
                value={fmtBytes(storage.recordingsBytes)}
                tone="warn"
              />
            </div>

            {/* Barra de disco usado/livre */}
            <div style={{ marginTop: 8 }}>
              <div className="storage-disk-head">
                <span>Disco</span>
                <span className="muted">
                  {fmtBytes(disk.used)} de {fmtBytes(disk.size)} ({diskPct}%) usado
                  {' · '}
                  {fmtBytes(disk.avail)} livre
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
          </>
        )}
      </section>

      {/* === 3. Segurança ================================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="check" size={18} /> Segurança
        </h2>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '12px 14px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(34, 197, 94, 0.10)',
            border: '1px solid rgba(34, 197, 94, 0.35)',
            color: '#a7e8c2',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              color: 'var(--live)',
              marginTop: 1,
              flexShrink: 0,
            }}
          >
            <Icon name="check" size={20} />
          </span>
          <div style={{ lineHeight: 1.5, fontSize: '0.92rem' }}>
            <strong style={{ color: '#d6f5e3' }}>Streams protegidos.</strong> Tanto o
            vídeo ao vivo (<code>/hls</code>) quanto as gravações (<code>/playback</code>)
            exigem login e respeitam as permissões de câmera de cada usuário. Sessões sem
            autenticação são bloqueadas e o token expira automaticamente.
          </div>
        </div>
      </section>

      {/* === 4. Gravação =================================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="recordings" size={18} /> Gravação e retenção
        </h2>
        <p className="muted" style={{ lineHeight: 1.6, marginTop: 0 }}>
          Cada câmera define sua própria política de retenção (em dias) na tela de{' '}
          <strong>Câmeras</strong>. Gravações mais antigas que esse período são removidas
          automaticamente para liberar espaço.
        </p>
        <div className="alert warn" style={{ marginTop: 4 }}>
          <strong>Atenção ao armazenamento:</strong> as gravações ocupam espaço em disco no
          servidor. Mantenha apenas as câmeras necessárias com gravação ligada e acompanhe o
          espaço livre acima para evitar que o disco encha.
        </div>
      </section>

      {/* === 5. Sobre ===================================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="settings" size={18} /> Sobre
        </h2>
        <dl className="info-list">
          <div className="info-row">
            <dt>Aplicação</dt>
            <dd>VizionPro</dd>
          </div>
          <div className="info-row">
            <dt>Versão</dt>
            <dd>
              <code>{APP_VERSION}</code>
            </dd>
          </div>
          <div className="info-row">
            <dt>Monitoramento</dt>
            <dd>Câmeras ao vivo, gravação contínua e relatórios em tempo real</dd>
          </div>
        </dl>
        <p className="field-hint" style={{ marginTop: 12 }}>
          VizionPro — plataforma de videomonitoramento. Acompanhe a saúde do sistema na aba{' '}
          <strong>Relatórios</strong>.
        </p>
      </section>
    </>
  );
}
