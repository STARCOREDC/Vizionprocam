import { useEffect, useMemo, useState } from 'react';
import { camerasApi } from '../api.js';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import SearchBar from '../components/SearchBar.jsx';
import Pagination from '../components/Pagination.jsx';
import Icon from '../components/Icon.jsx';
import { usePaginated } from '../hooks/usePaginated.js';
import { useToast } from '../components/Toast.jsx';

const PAGE_SIZE = 20;

const RETENTION_PRESETS = [1, 5, 10, 30];

const EMPTY_FORM = {
  name: '',
  rtsp_url: '',
  rtsp_url_sd: '',
  location: '',
  transcode: false,
  record: false,
  record_days: 10,
  motion: false,
  onvif_port: '',
  ai_daily_limit: 0,
  tamper_detect: false,
  audio_detect: false,
  audio_threshold_db: -18,
  face_recognition: false,
  enabled: true,
};

// Normaliza o estado de retenção: se record_days bate em um preset usa o chip,
// senão entra no modo "personalizado".
function retentionMode(days) {
  return RETENTION_PRESETS.includes(Number(days)) ? Number(days) : 'custom';
}

export default function CamerasAdmin() {
  const toast = useToast();
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Busca.
  const [query, setQuery] = useState('');

  // Modal de cadastro / edição (compartilha o mesmo form).
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null); // null => criar
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editLoading, setEditLoading] = useState(false);

  // Teste de RTSP.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // {ok,...} | {error}

  // Detecção ONVIF.
  const [onvifOpen, setOnvifOpen] = useState(false);
  const [onvif, setOnvif] = useState({
    ip: '',
    port: '8899',
    username: '',
    password: '',
  });
  const [onvifDetecting, setOnvifDetecting] = useState(false);
  const [onvifStreams, setOnvifStreams] = useState([]); // [{name,uri}]

  // Toggle enabled / exclusão.
  const [togglingId, setTogglingId] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const loadCameras = async () => {
    setError('');
    try {
      const list = await camerasApi.list();
      setCameras(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || 'Falha ao carregar câmeras.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCameras();
  }, []);

  // --- Filtro + paginação ---------------------------------------------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cameras;
    return cameras.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.location || '').toLowerCase().includes(q)
    );
  }, [cameras, query]);

  const { page, setPage, totalPages, slice } = usePaginated(filtered, PAGE_SIZE);

  // --- Form helpers ---------------------------------------------------------
  const onField = (key) => (e) =>
    setForm((f) => ({
      ...f,
      [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  const resetOnvif = () => {
    setOnvifOpen(false);
    setOnvif({ ip: '', port: '8899', username: '', password: '' });
    setOnvifStreams([]);
    setOnvifDetecting(false);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setTestResult(null);
    resetOnvif();
    setEditLoading(false);
    setFormOpen(true);
  };

  const openEdit = async (cam) => {
    setEditingId(cam.id);
    setFormError('');
    setTestResult(null);
    resetOnvif();
    setForm({ ...EMPTY_FORM, name: cam.name || '' });
    setEditLoading(true);
    setFormOpen(true);
    try {
      const full = await camerasApi.get(cam.id);
      setForm({
        name: full.name || '',
        rtsp_url: full.rtsp_url || '',
        rtsp_url_sd: full.rtsp_url_sd || '',
        location: full.location || '',
        transcode: !!full.transcode,
        record: !!full.record,
        record_days: full.record_days ?? 10,
        motion: !!full.motion,
        onvif_port: full.onvif_port != null ? String(full.onvif_port) : '',
        ai_daily_limit: full.ai_daily_limit ?? 0,
        tamper_detect: !!full.tamper_detect,
        audio_detect: !!full.audio_detect,
        audio_threshold_db: full.audio_threshold_db ?? -18,
        face_recognition: !!full.face_recognition,
        enabled: full.enabled !== false,
      });
    } catch (err) {
      setFormError(err.message || 'Falha ao carregar dados da câmera.');
    } finally {
      setEditLoading(false);
    }
  };

  const closeForm = () => {
    if (saving) return;
    setFormOpen(false);
  };

  // --- Retenção -------------------------------------------------------------
  const mode = retentionMode(form.record_days);
  const setPreset = (days) =>
    setForm((f) => ({ ...f, record_days: days }));
  const enableCustom = () =>
    setForm((f) => ({
      ...f,
      record_days: RETENTION_PRESETS.includes(Number(f.record_days))
        ? 15
        : f.record_days,
    }));

  // --- Teste de RTSP --------------------------------------------------------
  const onTestRtsp = async () => {
    const url = form.rtsp_url.trim();
    if (!url) {
      setTestResult({ error: 'Informe a URL RTSP antes de testar.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await camerasApi.testRtsp(url);
      const data = res?.result || res;
      setTestResult(data);
      if (data?.ok && data?.suggestTranscode && !form.transcode) {
        setForm((f) => ({ ...f, transcode: true }));
      }
    } catch (err) {
      setTestResult({ error: err.message || 'Não foi possível ler o RTSP.' });
    } finally {
      setTesting(false);
    }
  };

  // --- Detecção ONVIF -------------------------------------------------------
  const onOnvifField = (key) => (e) =>
    setOnvif((o) => ({ ...o, [key]: e.target.value }));

  const applyStream = (uri) => {
    setForm((f) => ({ ...f, rtsp_url: uri }));
    setTestResult(null);
  };

  const onOnvifDetect = async () => {
    const ip = onvif.ip.trim();
    if (!ip) {
      toast.error('Informe o IP da câmera para detectar via ONVIF.');
      return;
    }
    setOnvifDetecting(true);
    setOnvifStreams([]);
    try {
      const res = await camerasApi.onvifDetect({
        ip,
        port: onvif.port.trim() || undefined,
        username: onvif.username.trim() || undefined,
        password: onvif.password,
      });
      if (res?.ok && Array.isArray(res.streams) && res.streams.length > 0) {
        setOnvifStreams(res.streams);
        applyStream(res.streams[0].uri);
        toast.success('RTSP detectado!');
      } else {
        const msg = res?.error || 'Nenhum stream ONVIF encontrado.';
        toast.error(
          `${msg} Use o RTSP manual + Testar RTSP. (Câmeras genéricas às vezes não têm ONVIF habilitado.)`
        );
      }
    } catch (err) {
      toast.error(
        `${err.message || 'Falha na detecção ONVIF.'} Use o RTSP manual + Testar RTSP. (Câmeras genéricas às vezes não têm ONVIF habilitado.)`
      );
    } finally {
      setOnvifDetecting(false);
    }
  };

  // --- Salvar (criar ou editar) ---------------------------------------------
  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const name = form.name.trim();
    const rtsp_url = form.rtsp_url.trim();
    const location = form.location.trim();

    if (!name || !rtsp_url) {
      setFormError('Nome e URL RTSP são obrigatórios.');
      return;
    }

    const recordDays = form.record
      ? Math.max(1, parseInt(form.record_days, 10) || 1)
      : undefined;

    // String vazia -> null; porta ONVIF: número ou null (backend usa 8899 como padrão).
    const rtsp_url_sd = form.rtsp_url_sd.trim() || null;
    const motion = !!form.motion;
    const onvifPortNum = parseInt(form.onvif_port, 10);
    const onvif_port = Number.isFinite(onvifPortNum) ? onvifPortNum : null;

    // Limite diário de análises de IA (>=0; 0 = ilimitado).
    const aiLimitNum = parseInt(form.ai_daily_limit, 10);
    const ai_daily_limit = Number.isFinite(aiLimitNum) && aiLimitNum > 0 ? aiLimitNum : 0;
    const tamper_detect = !!form.tamper_detect;

    // Detecção de som: limiar em dB, clampado em [-60, 0] (padrão -18).
    const audio_detect = !!form.audio_detect;
    const thresholdNum = parseInt(form.audio_threshold_db, 10);
    const audio_threshold_db = Number.isFinite(thresholdNum)
      ? Math.min(0, Math.max(-60, thresholdNum))
      : -18;

    // Reconhecimento de moradores (avisa só de rostos desconhecidos).
    const face_recognition = !!form.face_recognition;

    setSaving(true);
    try {
      if (editingId) {
        const body = {
          name,
          rtsp_url,
          rtsp_url_sd,
          location,
          transcode: form.transcode,
          record: form.record,
          motion,
          onvif_port,
          ai_daily_limit,
          tamper_detect,
          audio_detect,
          audio_threshold_db,
          face_recognition,
          enabled: form.enabled,
        };
        if (recordDays !== undefined) body.record_days = recordDays;
        const res = await camerasApi.update(editingId, body);
        const cam = res?.camera || res;
        setCameras((prev) =>
          prev.map((c) => (c.id === editingId ? { ...c, ...cam } : c))
        );
        toast.success('Câmera atualizada.');
      } else {
        const body = {
          name,
          rtsp_url,
          rtsp_url_sd,
          location,
          transcode: form.transcode,
          record: form.record,
          motion,
          onvif_port,
          ai_daily_limit,
          tamper_detect,
          audio_detect,
          audio_threshold_db,
          face_recognition,
        };
        if (recordDays !== undefined) body.record_days = recordDays;
        const res = await camerasApi.create(body);
        const cam = res?.camera || res;
        setCameras((prev) => [...prev, cam]);
        toast.success('Câmera cadastrada.');
      }
      setFormOpen(false);
    } catch (err) {
      setFormError(err.message || 'Não foi possível salvar a câmera.');
    } finally {
      setSaving(false);
    }
  };

  // --- Toggle enabled -------------------------------------------------------
  const toggleEnabled = async (cam) => {
    setTogglingId(cam.id);
    try {
      const res = await camerasApi.update(cam.id, { enabled: !cam.enabled });
      const updated = res?.camera || res;
      setCameras((prev) =>
        prev.map((c) =>
          c.id === cam.id ? { ...c, enabled: updated.enabled } : c
        )
      );
      toast.success(updated.enabled ? 'Câmera ligada.' : 'Câmera desligada.');
    } catch (err) {
      toast.error(err.message || 'Falha ao alterar status.');
    } finally {
      setTogglingId(null);
    }
  };

  // --- Exclusão -------------------------------------------------------------
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await camerasApi.remove(toDelete.id);
      setCameras((prev) => prev.filter((c) => c.id !== toDelete.id));
      toast.success('Câmera excluída.');
      setToDelete(null);
    } catch (err) {
      toast.error(err.message || 'Falha ao excluir câmera.');
    } finally {
      setDeleting(false);
    }
  };

  const isEdit = editingId != null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Câmeras</h1>
          <p className="page-sub">Cadastre e gerencie as câmeras IP</p>
        </div>
        <button className="btn primary" onClick={openCreate}>
          <Icon name="plus" size={18} /> Nova câmera
        </button>
      </div>

      <section className="panel">
        <div className="panel-head-row">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Câmeras cadastradas
            {!loading && (
              <span className="count-pill">{filtered.length}</span>
            )}
          </h2>
          {!loading && !error && cameras.length > 0 && (
            <SearchBar
              value={query}
              onChange={setQuery}
              placeholder="Buscar por nome ou local…"
            />
          )}
        </div>

        {loading && (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        )}

        {!loading && error && (
          <div className="alert error">{error}</div>
        )}

        {!loading && !error && cameras.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="camera" size={40} />
            </span>
            <h2>Nenhuma câmera cadastrada</h2>
            <p>Adicione sua primeira câmera IP para começar a monitorar.</p>
            <button className="btn primary" onClick={openCreate}>
              <Icon name="plus" size={18} /> Nova câmera
            </button>
          </div>
        )}

        {!loading && !error && cameras.length > 0 && filtered.length === 0 && (
          <p className="muted">Nenhuma câmera corresponde à busca.</p>
        )}

        {!loading && !error && filtered.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Câmera</th>
                    <th>Local</th>
                    <th>Status</th>
                    <th>Transcode</th>
                    <th>Gravação</th>
                    <th>Ativa</th>
                    <th className="col-actions">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.map((cam) => {
                    const online = cam.online === true;
                    return (
                      <tr key={cam.id}>
                        <td data-label="Câmera">
                          <span className="cam-name">
                            {cam.favorite && (
                              <span
                                className="fav-star"
                                title="Favorita"
                                aria-label="Favorita"
                              >
                                ★
                              </span>
                            )}
                            {cam.name}
                          </span>
                          {cam.slug && (
                            <span className="cam-slug">{cam.slug}</span>
                          )}
                          {cam.motion && (
                            <span
                              className="badge badge-muted"
                              title="Detecção de movimento (ONVIF) ativa"
                            >
                              Movimento
                            </span>
                          )}
                        </td>
                        <td data-label="Local">{cam.location || '—'}</td>
                        <td data-label="Status">
                          {/* 3 estados: Online (transmitindo) | Em espera (sob demanda,
                              liga quando alguém assiste) | Offline (deveria estar
                              transmitindo — grava — mas não está = problema real) */}
                          {online ? (
                            <span className="status-dot on">
                              <span className="dot" />
                              Online
                            </span>
                          ) : cam.record ? (
                            <span className="status-dot off">
                              <span className="dot" />
                              Offline
                            </span>
                          ) : (
                            <span
                              className="status-dot standby"
                              title="Sob demanda: o stream liga quando alguém assiste (câmera sem gravação)."
                            >
                              <span className="dot" />
                              Em espera
                            </span>
                          )}
                        </td>
                        <td data-label="Transcode">
                          {cam.transcode ? (
                            <span className="badge badge-transcode">
                              H.265→H.264
                            </span>
                          ) : (
                            <span className="badge badge-muted">Direto</span>
                          )}
                        </td>
                        <td data-label="Gravação">
                          {cam.record ? (
                            <span className="badge badge-rec">
                              <Icon name="dot" size={10} /> Gravando
                              {cam.record_days
                                ? ` · ${cam.record_days}d`
                                : ''}
                            </span>
                          ) : (
                            <span className="badge badge-muted">—</span>
                          )}
                        </td>
                        <td data-label="Ativa">
                          <span
                            className={`status-pill ${
                              cam.enabled === false ? 'off' : 'on'
                            }`}
                          >
                            {cam.enabled === false ? 'Desativada' : 'Ativa'}
                          </span>
                        </td>
                        <td className="col-actions" data-label="Ações">
                          <div className="row-actions">
                            <button
                              className="icon-btn"
                              title="Editar"
                              aria-label="Editar"
                              onClick={() => openEdit(cam)}
                            >
                              <Icon name="edit" size={16} />
                            </button>
                            <button
                              className="icon-btn"
                              title={
                                cam.enabled === false
                                  ? 'Ligar câmera'
                                  : 'Desligar câmera'
                              }
                              aria-label="Ligar/desligar"
                              onClick={() => toggleEnabled(cam)}
                              disabled={togglingId === cam.id}
                            >
                              <Icon
                                name={
                                  cam.enabled === false ? 'play' : 'x'
                                }
                                size={16}
                              />
                            </button>
                            <button
                              className="icon-btn danger"
                              title="Excluir"
                              aria-label="Excluir"
                              onClick={() => setToDelete(cam)}
                            >
                              <Icon name="trash" size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              total={filtered.length}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          </>
        )}
      </section>

      {/* Modal cadastrar / editar */}
      <Modal
        open={formOpen}
        title={isEdit ? `Editar — ${form.name || 'câmera'}` : 'Nova câmera'}
        onClose={closeForm}
        footer={
          <>
            <button
              type="button"
              className="btn ghost"
              onClick={closeForm}
              disabled={saving}
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="camera-form"
              className="btn primary"
              disabled={saving || editLoading}
            >
              {saving
                ? 'Salvando…'
                : isEdit
                ? 'Salvar alterações'
                : 'Adicionar câmera'}
            </button>
          </>
        }
      >
        {editLoading ? (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        ) : (
          <form id="camera-form" className="camera-form" onSubmit={onSubmit}>
            <div className="form-row">
              <label className="field">
                <span>Nome</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={onField('name')}
                  placeholder="Entrada principal"
                  autoFocus
                  required
                />
              </label>
              <label className="field">
                <span>Localização</span>
                <input
                  type="text"
                  value={form.location}
                  onChange={onField('location')}
                  placeholder="Recepção - Térreo"
                />
              </label>
            </div>

            <label className="field">
              <span>URL RTSP</span>
              <div className="rtsp-row">
                <input
                  type="text"
                  value={form.rtsp_url}
                  onChange={onField('rtsp_url')}
                  placeholder="rtsp://usuario:senha@10.0.0.50:554/stream1"
                  required
                />
                <button
                  type="button"
                  className="btn ghost"
                  onClick={onTestRtsp}
                  disabled={testing}
                >
                  {testing ? 'Testando…' : 'Testar RTSP'}
                </button>
              </div>
              <small className="field-hint">
                Formato: rtsp://usuario:senha@ip:554/caminho
              </small>
            </label>

            <label className="field">
              <span>RTSP secundário (SD) — opcional</span>
              <input
                type="text"
                value={form.rtsp_url_sd}
                onChange={onField('rtsp_url_sd')}
                placeholder="rtsp://usuario:senha@10.0.0.50:554/stream2"
              />
              <small className="field-hint">
                Stream de menor qualidade da câmera (ex: subtype=1 / stream=1).
                Habilita o botão HD/SD no app.
              </small>
            </label>

            {/* Detecção via ONVIF */}
            <div className="onvif-box">
              <button
                type="button"
                className="onvif-toggle"
                onClick={() => setOnvifOpen((v) => !v)}
                aria-expanded={onvifOpen}
              >
                <Icon name={onvifOpen ? 'x' : 'search'} size={16} />
                {onvifOpen ? 'Fechar ONVIF' : 'Detectar via ONVIF'}
              </button>

              {onvifOpen && (
                <div className="onvif-panel">
                  <p className="field-hint onvif-hint">
                    Informe os dados de acesso da câmera para descobrir o RTSP
                    automaticamente.
                  </p>
                  <div className="form-row">
                    <label className="field">
                      <span>IP</span>
                      <input
                        type="text"
                        value={onvif.ip}
                        onChange={onOnvifField('ip')}
                        placeholder="10.0.0.50"
                      />
                    </label>
                    <label className="field">
                      <span>Porta</span>
                      <input
                        type="text"
                        value={onvif.port}
                        onChange={onOnvifField('port')}
                        placeholder="8899"
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="field">
                      <span>Usuário</span>
                      <input
                        type="text"
                        value={onvif.username}
                        onChange={onOnvifField('username')}
                        placeholder="admin"
                      />
                    </label>
                    <label className="field">
                      <span>Senha</span>
                      <input
                        type="password"
                        value={onvif.password}
                        onChange={onOnvifField('password')}
                        placeholder="••••••"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="btn primary onvif-detect-btn"
                    onClick={onOnvifDetect}
                    disabled={onvifDetecting}
                  >
                    {onvifDetecting ? 'Detectando…' : 'Detectar'}
                  </button>

                  {onvifStreams.length > 1 && (
                    <div className="onvif-streams">
                      <span className="onvif-streams-label">
                        Streams encontrados — clique para usar:
                      </span>
                      {onvifStreams.map((s, i) => (
                        <button
                          key={`${s.uri}-${i}`}
                          type="button"
                          className={`onvif-stream ${
                            form.rtsp_url === s.uri ? 'active' : ''
                          }`}
                          onClick={() => applyStream(s.uri)}
                        >
                          <span className="onvif-stream-name">
                            {s.name || `Stream ${i + 1}`}
                          </span>
                          <span className="onvif-stream-uri">{s.uri}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {testResult && (
              <RtspResult result={testResult} />
            )}

            <div className="check-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.transcode}
                  onChange={onField('transcode')}
                />
                <span>
                  Converter H.265 → H.264{' '}
                  <em>(transcode — use se a câmera é HEVC)</em>
                </span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.record}
                  onChange={onField('record')}
                />
                <span>Gravar (manter gravações desta câmera)</span>
              </label>
            </div>

            {form.record && (
              <div className="retention">
                <span className="retention-label">Retenção das gravações</span>
                <div className="retention-chips">
                  {RETENTION_PRESETS.map((d) => (
                    <button
                      type="button"
                      key={d}
                      className={`chip ${
                        mode === d ? 'active' : ''
                      }`}
                      onClick={() => setPreset(d)}
                    >
                      {d} {d === 1 ? 'dia' : 'dias'}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`chip ${mode === 'custom' ? 'active' : ''}`}
                    onClick={enableCustom}
                  >
                    Personalizado
                  </button>
                </div>
                {mode === 'custom' && (
                  <label className="field retention-custom">
                    <span>Dias de retenção</span>
                    <input
                      type="number"
                      min="1"
                      value={form.record_days}
                      onChange={onField('record_days')}
                    />
                  </label>
                )}
              </div>
            )}

            {/* Detecção de movimento (ONVIF) */}
            <div className="check-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!form.motion}
                  onChange={onField('motion')}
                />
                <span>
                  Ativar eventos de movimento{' '}
                  <em>(a câmera precisa suportar ONVIF events)</em>
                </span>
              </label>
            </div>
            {form.motion && (
              <label className="field">
                <span>Porta ONVIF</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={form.onvif_port}
                  onChange={onField('onvif_port')}
                  placeholder="8899"
                />
                <small className="field-hint">
                  Funciona em câmeras Intelbras/Hikvision/DVRs com ONVIF. Gera
                  eventos e alertas automáticos.
                </small>
              </label>
            )}

            {/* Detecção inteligente (IA) */}
            <label className="field">
              <span>Limite diário de análises de IA</span>
              <input
                type="number"
                min="0"
                value={form.ai_daily_limit}
                onChange={onField('ai_daily_limit')}
                placeholder="0"
              />
              <small className="field-hint">
                Protege contra custo excessivo. 0 = sem limite.
              </small>
            </label>

            <div className="check-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!form.tamper_detect}
                  onChange={onField('tamper_detect')}
                />
                <span>
                  Alerta de sabotagem{' '}
                  <em>
                    (avisar se a câmera for obstruída/desconectada enquanto
                    armada)
                  </em>
                </span>
              </label>
            </div>

            {/* Detecção de som — alerta com barulho alto/anormal */}
            <div className="check-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!form.audio_detect}
                  onChange={onField('audio_detect')}
                />
                <span>
                  🔊 Detecção de som{' '}
                  <em>(alerta com barulho alto/anormal)</em>
                </span>
              </label>
            </div>
            {form.audio_detect && (
              <label className="field">
                <span>Limiar de som (dB)</span>
                <input
                  type="number"
                  min="-60"
                  max="0"
                  value={form.audio_threshold_db}
                  onChange={onField('audio_threshold_db')}
                  placeholder="-18"
                />
                <small className="field-hint">
                  Mais perto de 0 = só barulhos mais altos. Padrão -18.
                </small>
              </label>
            )}

            {/* Reconhecimento de moradores — avisa só de desconhecidos */}
            <div className="check-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!form.face_recognition}
                  onChange={onField('face_recognition')}
                />
                <span>
                  👤 Reconhecimento de moradores{' '}
                  <em>(avisa só de desconhecidos)</em>
                </span>
              </label>
            </div>
            {form.face_recognition && (
              <small className="field-hint" style={{ marginTop: -4 }}>
                O cliente cadastra os rostos da família no app.
              </small>
            )}

            {isEdit && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!form.enabled}
                  onChange={onField('enabled')}
                />
                <span>Câmera ativa (habilitada)</span>
              </label>
            )}

            {formError && <div className="alert error">{formError}</div>}
          </form>
        )}
      </Modal>

      {/* Confirmação de exclusão */}
      <ConfirmDialog
        open={!!toDelete}
        title="Excluir câmera"
        message={
          toDelete
            ? `Tem certeza que deseja excluir a câmera "${toDelete.name}"? Esta ação não pode ser desfeita.`
            : ''
        }
        confirmText="Excluir"
        danger
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </>
  );
}

// Resultado bonito do teste de RTSP.
function RtspResult({ result }) {
  if (result.error || result.ok === false) {
    return (
      <div className="rtsp-result error">
        <span className="rtsp-result-icon">⚠</span>
        <span>
          {result.error || 'Não foi possível ler o RTSP.'}
        </span>
      </div>
    );
  }

  const codec = (result.codec || '').toUpperCase();
  const dims =
    result.width && result.height
      ? `${result.width}x${result.height}`
      : '';
  const fps = result.fps ? `${result.fps}fps` : '';
  const audio = result.hasAudio ? 'áudio: sim' : 'áudio: não';
  const parts = [codec, dims, fps, audio].filter(Boolean).join(' · ');

  return (
    <div className="rtsp-result ok">
      <div className="rtsp-result-line">
        <span className="rtsp-result-icon">✓</span>
        <span>{parts || 'Stream lido com sucesso.'}</span>
      </div>
      {result.suggestTranscode && (
        <div className="rtsp-result-hint">
          HEVC detectado — transcode recomendado (marcado automaticamente).
        </div>
      )}
    </div>
  );
}
