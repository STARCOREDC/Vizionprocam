import { useEffect, useRef, useState } from 'react';
import { presetsApi, integrationsApi } from '../api.js';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Icon from '../components/Icon.jsx';
import { useToast } from '../components/Toast.jsx';

const USAGE_REFRESH_MS = 30000;

const EMPTY_PRESET = {
  key: '',
  name: '',
  emoji: '',
  prompt: '',
};

// Trunca o prompt para exibição resumida na tabela.
function summarize(text, max = 80) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function moneyUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'US$ 0,00';
  return `US$ ${n.toFixed(2)}`;
}

function shortDay(date) {
  // 'YYYY-MM-DD' -> 'DD/MM' (sem depender de timezone).
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    const [, m, d] = date.split('-');
    return `${d}/${m}`;
  }
  return date || '';
}

export default function DeteccaoIA() {
  const toast = useToast();

  // --- Presets --------------------------------------------------------------
  const [presets, setPresets] = useState([]);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [presetsError, setPresetsError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null); // null => criar
  const [form, setForm] = useState(EMPTY_PRESET);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // --- Uso da IA ------------------------------------------------------------
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [usageError, setUsageError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const timerRef = useRef(null);

  const isEdit = editingId != null;

  // --- Carregamento de presets ---------------------------------------------
  const loadPresets = async () => {
    setPresetsError('');
    try {
      const list = await presetsApi.list();
      setPresets(Array.isArray(list) ? list : []);
    } catch (err) {
      setPresetsError(err.message || 'Falha ao carregar os tipos de detecção.');
    } finally {
      setLoadingPresets(false);
    }
  };

  useEffect(() => {
    loadPresets();
  }, []);

  // --- Carregamento de uso --------------------------------------------------
  const loadUsage = async (d = days) => {
    setUsageError('');
    try {
      const res = await integrationsApi.aiUsage(d);
      setUsage(res || null);
    } catch (err) {
      setUsageError(err.message || 'Falha ao carregar o uso da IA.');
    } finally {
      setLoadingUsage(false);
    }
  };

  useEffect(() => {
    setLoadingUsage(true);
    loadUsage(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  useEffect(() => {
    if (!autoRefresh) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    timerRef.current = setInterval(() => loadUsage(days), USAGE_REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, days]);

  // --- Form helpers ---------------------------------------------------------
  const onField = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_PRESET);
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (p) => {
    setEditingId(p.id);
    setForm({
      key: p.key || '',
      name: p.name || '',
      emoji: p.emoji || '',
      prompt: p.prompt || '',
    });
    setFormError('');
    setFormOpen(true);
  };

  const closeForm = () => {
    if (saving) return;
    setFormOpen(false);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const name = form.name.trim();
    const emoji = form.emoji.trim();
    const prompt = form.prompt.trim();
    const key = form.key.trim();

    if (!name || !prompt) {
      setFormError('Nome e instrução (prompt) são obrigatórios.');
      return;
    }
    if (!isEdit && !key) {
      setFormError('A chave (key) é obrigatória.');
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        const res = await presetsApi.update(editingId, { name, emoji, prompt });
        const saved = res?.preset || res;
        setPresets((prev) =>
          prev.map((p) => (p.id === editingId ? { ...p, ...saved } : p))
        );
        toast.success('Tipo de detecção atualizado.');
      } else {
        const res = await presetsApi.create({ key, name, emoji, prompt });
        const saved = res?.preset || res;
        setPresets((prev) => [...prev, saved]);
        toast.success('Tipo de detecção criado.');
      }
      setFormOpen(false);
    } catch (err) {
      setFormError(err.message || 'Não foi possível salvar o tipo.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await presetsApi.remove(toDelete.id);
      setPresets((prev) => prev.filter((p) => p.id !== toDelete.id));
      toast.success('Tipo de detecção excluído.');
      setToDelete(null);
    } catch (err) {
      toast.error(err.message || 'Falha ao excluir o tipo.');
    } finally {
      setDeleting(false);
    }
  };

  // --- Derivados do uso -----------------------------------------------------
  const byDay = Array.isArray(usage?.byDay) ? usage.byDay : [];
  const byCamera = Array.isArray(usage?.byCamera) ? usage.byCamera : [];
  const maxDay = byDay.reduce((m, d) => Math.max(m, Number(d.count) || 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Detecção Inteligente (IA)</h1>
          <p className="page-sub">
            Tipos de detecção e uso da análise por IA
          </p>
        </div>
        <button className="btn primary" onClick={openCreate}>
          <Icon name="plus" size={18} /> Novo tipo
        </button>
      </div>

      {/* === Card: Tipos de detecção ==================================== */}
      <section className="panel">
        <div className="panel-head-row">
          <h2 className="panel-title" style={{ margin: 0 }}>
            <Icon name="cpu" size={18} /> Tipos de detecção
            {!loadingPresets && (
              <span className="count-pill">{presets.length}</span>
            )}
          </h2>
        </div>

        <div className="alert info" style={{ marginBottom: 14 }}>
          Estes são os tipos que o cliente pode escolher para cada câmera no app.
        </div>

        {loadingPresets && (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        )}

        {!loadingPresets && presetsError && (
          <div className="alert error">{presetsError}</div>
        )}

        {!loadingPresets && !presetsError && presets.length === 0 && (
          <p className="muted">Nenhum tipo de detecção cadastrado ainda.</p>
        )}

        {!loadingPresets && !presetsError && presets.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Chave</th>
                  <th>Instrução (resumo)</th>
                  <th className="col-actions">Ações</th>
                </tr>
              </thead>
              <tbody>
                {presets.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Tipo">
                      <span className="cam-name">
                        {p.emoji && (
                          <span style={{ marginRight: 6 }}>{p.emoji}</span>
                        )}
                        {p.name}
                      </span>
                      {p.builtin && (
                        <span className="badge badge-muted" title="Tipo padrão do sistema">
                          padrão
                        </span>
                      )}
                    </td>
                    <td data-label="Chave">
                      <code>{p.key}</code>
                    </td>
                    <td data-label="Instrução">
                      <span className="muted">{summarize(p.prompt)}</span>
                    </td>
                    <td className="col-actions" data-label="Ações">
                      <div className="row-actions">
                        <button
                          className="icon-btn"
                          title="Editar"
                          aria-label="Editar"
                          onClick={() => openEdit(p)}
                        >
                          <Icon name="edit" size={16} />
                        </button>
                        {!p.builtin && (
                          <button
                            className="icon-btn danger"
                            title="Excluir"
                            aria-label="Excluir"
                            onClick={() => setToDelete(p)}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* === Card: Uso da IA ============================================ */}
      <section className="panel">
        <div className="panel-head-row">
          <h2 className="panel-title" style={{ margin: 0 }}>
            <Icon name="activity" size={18} /> Uso da IA
          </h2>
          <div className="head-actions">
            <div className="retention-chips" style={{ margin: 0 }}>
              <button
                type="button"
                className={`chip ${days === 7 ? 'active' : ''}`}
                onClick={() => setDays(7)}
              >
                7 dias
              </button>
              <button
                type="button"
                className={`chip ${days === 30 ? 'active' : ''}`}
                onClick={() => setDays(30)}
              >
                30 dias
              </button>
            </div>
            <label
              className="check"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              <span>Auto-atualizar</span>
            </label>
            <button
              className="btn ghost"
              onClick={() => {
                setLoadingUsage(true);
                loadUsage(days);
              }}
            >
              Atualizar
            </button>
          </div>
        </div>

        {loadingUsage && (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        )}

        {!loadingUsage && usageError && (
          <div className="alert error">{usageError}</div>
        )}

        {!loadingUsage && !usageError && usage && (
          <>
            {/* Resumo */}
            <section className="sys-grid">
              <div className="panel sys-card sys-card-value">
                <span className="stat-icon" aria-hidden="true">
                  <Icon name="activity" size={22} />
                </span>
                <div className="stat-body">
                  <span className="stat-value">{usage.totalToday ?? 0}</span>
                  <span className="stat-label">Análises hoje</span>
                </div>
              </div>
              <div className="panel sys-card sys-card-value">
                <span className="stat-icon" aria-hidden="true">
                  <Icon name="reports" size={22} />
                </span>
                <div className="stat-body">
                  <span className="stat-value">{usage.totalPeriod ?? 0}</span>
                  <span className="stat-label">
                    Análises no período ({days} dias)
                  </span>
                </div>
              </div>
              <div className="panel sys-card sys-card-value">
                <span className="stat-icon" aria-hidden="true">
                  <Icon name="database" size={22} />
                </span>
                <div className="stat-body">
                  <span className="stat-value">
                    {moneyUsd(usage.estimatedCostUsd)}
                  </span>
                  <span className="stat-label">Custo estimado</span>
                </div>
              </div>
            </section>

            {/* Mini-gráfico por dia */}
            <div style={{ marginTop: 8, marginBottom: 18 }}>
              <span className="sys-card-title">Análises por dia</span>
              {byDay.length === 0 ? (
                <p className="muted" style={{ marginTop: 8 }}>
                  Sem dados no período.
                </p>
              ) : (
                <div className="ai-usage-chart">
                  {byDay.map((d) => {
                    const count = Number(d.count) || 0;
                    const h = maxDay > 0 ? Math.round((count / maxDay) * 100) : 0;
                    return (
                      <div
                        key={d.date}
                        className="ai-usage-bar-col"
                        title={`${shortDay(d.date)}: ${count}`}
                      >
                        <span className="ai-usage-bar-count">{count}</span>
                        <div className="ai-usage-bar-track">
                          <div
                            className="ai-usage-bar-fill"
                            style={{ height: `${Math.max(h, count > 0 ? 4 : 0)}%` }}
                          />
                        </div>
                        <span className="ai-usage-bar-label">
                          {shortDay(d.date)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Por câmera */}
            <div>
              <span className="sys-card-title">Por câmera</span>
              {byCamera.length === 0 ? (
                <p className="muted" style={{ marginTop: 8 }}>
                  Nenhuma análise por câmera no período.
                </p>
              ) : (
                <div className="table-wrap" style={{ marginTop: 8 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Câmera</th>
                        <th>Análises</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byCamera.map((c) => (
                        <tr key={c.camera_id}>
                          <td data-label="Câmera">{c.name || `#${c.camera_id}`}</td>
                          <td data-label="Análises">{c.count ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {/* Modal criar / editar tipo */}
      <Modal
        open={formOpen}
        title={isEdit ? `Editar — ${form.name || 'tipo'}` : 'Novo tipo de detecção'}
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
              form="preset-form"
              className="btn primary"
              disabled={saving}
            >
              {saving
                ? 'Salvando…'
                : isEdit
                ? 'Salvar alterações'
                : 'Criar tipo'}
            </button>
          </>
        }
      >
        <form id="preset-form" className="camera-form" onSubmit={onSubmit}>
          <div className="form-row">
            <label className="field">
              <span>Chave (key)</span>
              <input
                type="text"
                value={form.key}
                onChange={onField('key')}
                placeholder="ex: pessoa"
                disabled={isEdit}
                autoFocus={!isEdit}
              />
              <small className="field-hint">
                Identificador interno. Não pode ser alterado depois de criado.
              </small>
            </label>
            <label className="field">
              <span>Emoji</span>
              <input
                type="text"
                value={form.emoji}
                onChange={onField('emoji')}
                placeholder="🚶"
                maxLength={4}
              />
            </label>
          </div>

          <label className="field">
            <span>Nome</span>
            <input
              type="text"
              value={form.name}
              onChange={onField('name')}
              placeholder="Pessoa"
              autoFocus={isEdit}
              required
            />
          </label>

          <label className="field">
            <span>Instrução para a IA</span>
            <textarea
              className="textarea"
              value={form.prompt}
              onChange={onField('prompt')}
              placeholder="Descreva o que a IA deve procurar nesta detecção (ex: identificar pessoas se aproximando da entrada)."
              rows={5}
              required
            />
            <small className="field-hint">
              Instrução pra IA: o que procurar na imagem desta detecção.
            </small>
          </label>

          {formError && <div className="alert error">{formError}</div>}
        </form>
      </Modal>

      {/* Confirmação de exclusão */}
      <ConfirmDialog
        open={!!toDelete}
        title="Excluir tipo de detecção"
        message={
          toDelete
            ? `Tem certeza que deseja excluir o tipo "${toDelete.name}"? Esta ação não pode ser desfeita.`
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
