import { useEffect, useMemo, useState } from 'react';
import { alertsApi, groupsApi, usersApi } from '../api.js';
import SearchBar from '../components/SearchBar.jsx';
import Pagination from '../components/Pagination.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { useToast } from '../components/Toast.jsx';
import { usePaginated } from '../hooks/usePaginated.js';

const PAGE_SIZE = 20;

const LEVELS = [
  { value: 'info', label: 'Informação' },
  { value: 'warning', label: 'Aviso' },
  { value: 'critical', label: 'Crítico' },
];

// Modelos pré-configurados que preenchem o formulário ao clicar.
const TEMPLATES = [
  {
    key: 'manutencao',
    chip: 'Manutenção programada',
    title: 'Manutenção programada',
    message:
      'O sistema passará por manutenção programada. Pode haver instabilidade temporária no acesso às câmeras.',
    level: 'warning',
  },
  {
    key: 'offline',
    chip: 'Câmera offline',
    title: 'Câmera offline',
    message:
      'Detectamos que uma de suas câmeras está offline. Verifique a conexão e a energia do equipamento.',
    level: 'critical',
  },
  {
    key: 'bemvindo',
    chip: 'Bem-vindo!',
    title: 'Bem-vindo ao VizionPro!',
    message:
      'Sua conta está pronta. Acesse o app para visualizar suas câmeras ao vivo e gravações.',
    level: 'info',
  },
  {
    key: 'pagamento',
    chip: 'Aviso de pagamento',
    title: 'Aviso de pagamento',
    message:
      'Sua fatura está disponível. Regularize o pagamento para evitar a suspensão do serviço.',
    level: 'warning',
  },
  {
    key: 'atualizacao',
    chip: 'Atualização do app',
    title: 'Atualização do app',
    message:
      'Uma nova versão do aplicativo está disponível com melhorias e correções. Atualize para a melhor experiência.',
    level: 'info',
  },
];

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR');
}

function levelLabel(level) {
  return LEVELS.find((l) => l.value === level)?.label || level;
}

export default function Alertas() {
  const toast = useToast();

  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Selects de alvo.
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);

  // Formulário.
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState('info');
  const [targetType, setTargetType] = useState('all'); // all | user | group
  const [targetId, setTargetId] = useState('');
  const [sending, setSending] = useState(false);

  // Busca + exclusão.
  const [query, setQuery] = useState('');
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setError('');
    try {
      const [list, grps, usrs] = await Promise.all([
        alertsApi.list(),
        groupsApi.list().catch(() => []),
        usersApi.list().catch(() => []),
      ]);
      setAlerts(Array.isArray(list) ? list : []);
      setGroups(Array.isArray(grps) ? grps : []);
      setUsers(Array.isArray(usrs) ? usrs : []);
    } catch (err) {
      setError(err.message || 'Falha ao carregar alertas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const applyTemplate = (tpl) => {
    setTitle(tpl.title);
    setMessage(tpl.message);
    setLevel(tpl.level);
  };

  const onTargetTypeChange = (type) => {
    setTargetType(type);
    setTargetId('');
  };

  const resetForm = () => {
    setTitle('');
    setMessage('');
    setLevel('info');
    setTargetType('all');
    setTargetId('');
  };

  const canSend =
    title.trim() &&
    message.trim() &&
    (targetType === 'all' || targetId);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      const body = {
        title: title.trim(),
        message: message.trim(),
        level,
        target_type: targetType,
        target_id: targetType === 'all' ? null : targetId,
      };
      await alertsApi.create(body);
      toast.success('Alerta enviado.');
      resetForm();
      await load();
    } catch (err) {
      toast.error(err.message || 'Falha ao enviar alerta.');
    } finally {
      setSending(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await alertsApi.remove(toDelete.id);
      setAlerts((prev) => prev.filter((a) => a.id !== toDelete.id));
      toast.success('Alerta excluído.');
      setToDelete(null);
    } catch (err) {
      toast.error(err.message || 'Falha ao excluir.');
    } finally {
      setDeleting(false);
    }
  };

  // Filtro por título.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return alerts;
    return alerts.filter((a) => (a.title || '').toLowerCase().includes(q));
  }, [alerts, query]);

  const { page, setPage, slice } = usePaginated(filtered, PAGE_SIZE);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Alertas</h1>
          <p className="page-sub">Crie e envie alertas para os usuários</p>
        </div>
      </div>

      <div className="alert info" style={{ marginBottom: 22 }}>
        Os alertas aparecem no app dos usuários que se aplicam.
      </div>

      {/* Formulário de novo alerta */}
      <section className="panel">
        <h2 className="panel-title">Novo alerta</h2>

        {/* Modelos pré-configurados */}
        <div className="template-chips">
          {TEMPLATES.map((tpl) => (
            <button
              type="button"
              key={tpl.key}
              className="chip"
              onClick={() => applyTemplate(tpl)}
            >
              {tpl.chip}
            </button>
          ))}
        </div>

        <form className="camera-form" onSubmit={onSubmit}>
          <label className="field">
            <span>Título</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex: Manutenção programada"
              required
            />
          </label>

          <label className="field">
            <span>Mensagem</span>
            <textarea
              className="textarea"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Conteúdo do alerta…"
              rows={4}
              required
            />
          </label>

          <div className="form-row">
            <label className="field">
              <span>Nível</span>
              <select
                className="select"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="field">
              <span>Alvo</span>
              <div className="radio-row">
                <label className="radio">
                  <input
                    type="radio"
                    name="target"
                    checked={targetType === 'all'}
                    onChange={() => onTargetTypeChange('all')}
                  />
                  <span>Todos</span>
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="target"
                    checked={targetType === 'user'}
                    onChange={() => onTargetTypeChange('user')}
                  />
                  <span>Usuário</span>
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="target"
                    checked={targetType === 'group'}
                    onChange={() => onTargetTypeChange('group')}
                  />
                  <span>Grupo</span>
                </label>
              </div>
            </div>
          </div>

          {targetType === 'user' && (
            <label className="field">
              <span>Selecione o usuário</span>
              <select
                className="select"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                required
              >
                <option value="">— escolher —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
                  </option>
                ))}
              </select>
            </label>
          )}

          {targetType === 'group' && (
            <label className="field">
              <span>Selecione o grupo</span>
              <select
                className="select"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                required
              >
                <option value="">— escolher —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="form-actions">
            <button
              className="btn primary"
              type="submit"
              disabled={sending || !canSend}
            >
              {sending ? 'Enviando…' : 'Enviar alerta'}
            </button>
          </div>
        </form>
      </section>

      {/* Lista de alertas enviados */}
      <section className="panel">
        <div className="panel-head-row">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Alertas enviados
            {!loading && <span className="count-pill">{filtered.length}</span>}
          </h2>
          <SearchBar
            value={query}
            onChange={(v) => {
              setQuery(v);
              setPage(1);
            }}
            placeholder="Buscar por título…"
          />
        </div>

        {loading && (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        )}
        {!loading && error && <div className="alert error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <p className="muted">Nenhum alerta enviado ainda.</p>
        )}

        {!loading && !error && filtered.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Título</th>
                    <th>Nível</th>
                    <th>Alvo</th>
                    <th>Data</th>
                    <th className="col-actions">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.map((a) => (
                    <tr key={a.id}>
                      <td data-label="Título">{a.title}</td>
                      <td data-label="Nível">
                        <span className={`level-badge ${a.level}`}>
                          {levelLabel(a.level)}
                        </span>
                      </td>
                      <td data-label="Alvo">
                        {a.target_name ||
                          (a.target_type === 'all' || !a.target_type
                            ? 'Todos'
                            : '—')}
                      </td>
                      <td data-label="Data">
                        {fmtDateTime(a.created_at || a.createdAt)}
                      </td>
                      <td className="col-actions" data-label="Ações">
                        <div className="row-actions">
                          <button
                            className="btn danger small"
                            onClick={() => setToDelete(a)}
                          >
                            Excluir
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
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

      <ConfirmDialog
        open={!!toDelete}
        title="Excluir alerta"
        message={
          toDelete ? `Excluir o alerta "${toDelete.title}"?` : ''
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
