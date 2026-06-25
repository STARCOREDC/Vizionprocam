import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { usersApi, groupsApi, camerasApi } from '../api.js';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import SearchBar from '../components/SearchBar.jsx';
import Pagination from '../components/Pagination.jsx';
import Icon from '../components/Icon.jsx';
import { usePaginated } from '../hooks/usePaginated.js';
import { useToast } from '../components/Toast.jsx';

const PAGE_SIZE = 20;
const EMPTY_CREATE = { username: '', password: '', role: 'viewer' };

const ROLE_FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'admin', label: 'Admin' },
  { key: 'viewer', label: 'Viewer' },
];

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Lista de checkboxes com busca embutida (aparece quando há mais de 6 itens).
 */
function CheckListPicker({
  items,
  selected,
  onToggle,
  query,
  onQuery,
  searchPlaceholder,
  emptyText,
  getName,
  getSub,
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      `${getName(it)} ${getSub(it) || ''}`.toLowerCase().includes(q)
    );
  }, [items, query, getName, getSub]);

  if (items.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <>
      {items.length > 6 && (
        <div style={{ marginBottom: 10 }}>
          <SearchBar
            value={query}
            onChange={onQuery}
            placeholder={searchPlaceholder}
          />
        </div>
      )}
      {filtered.length === 0 ? (
        <p className="muted">Nada corresponde à busca.</p>
      ) : (
        <div className="check-list">
          {filtered.map((it) => (
            <label className="check-item" key={it.id}>
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onChange={() => onToggle(it.id)}
              />
              <span className="check-item-main">
                <span className="check-item-name">{getName(it)}</span>
                {getSub(it) && (
                  <span className="check-item-sub">{getSub(it)}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

export default function Usuarios() {
  const toast = useToast();
  const { user: me } = useAuth();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Busca + filtro por papel.
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');

  // Catálogo (grupos + câmeras) compartilhado pelos modais de criar/editar.
  const [allGroups, setAllGroups] = useState([]);
  const [allCameras, setAllCameras] = useState([]);
  const [selGroups, setSelGroups] = useState(new Set());
  const [selCameras, setSelCameras] = useState(new Set());
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState('');
  const [groupQuery, setGroupQuery] = useState('');
  const [camQuery, setCamQuery] = useState('');

  // Criar (modal).
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  // Editar (modal único: conta + grupos + câmeras).
  const [editing, setEditing] = useState(null);
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState('viewer');
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Excluir.
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const loadUsers = async () => {
    setError('');
    try {
      const list = await usersApi.list();
      setUsers(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || 'Falha ao carregar usuários.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  // --- Filtro + paginação ---------------------------------------------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (q && !(u.username || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, query, roleFilter]);

  const { page, setPage, slice } = usePaginated(filtered, PAGE_SIZE);

  // --- Helpers de seleção -----------------------------------------------------
  const toggleSet = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const resetLinks = () => {
    setSelGroups(new Set());
    setSelCameras(new Set());
    setGroupQuery('');
    setCamQuery('');
    setLinksError('');
  };

  // --- Criar ----------------------------------------------------------------
  const onCreateField = (key) => (e) =>
    setCreateForm((f) => ({ ...f, [key]: e.target.value }));

  const openCreate = async () => {
    setCreateForm(EMPTY_CREATE);
    setCreateError('');
    resetLinks();
    setShowCreate(true);
    setLinksLoading(true);
    try {
      const [groups, cams] = await Promise.all([
        groupsApi.list(),
        camerasApi.list(),
      ]);
      setAllGroups(Array.isArray(groups) ? groups : []);
      setAllCameras(Array.isArray(cams) ? cams : []);
    } catch (err) {
      setLinksError(err.message || 'Falha ao carregar grupos e câmeras.');
    } finally {
      setLinksLoading(false);
    }
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    const username = createForm.username.trim();
    if (!username || !createForm.password) {
      setCreateError('Usuário e senha são obrigatórios.');
      return;
    }
    setCreating(true);
    try {
      const created = await usersApi.create({
        username,
        password: createForm.password,
        role: createForm.role,
      });

      // Aplica vínculos (só faz sentido para viewer; admin vê tudo).
      const wantsLinks =
        createForm.role === 'viewer' &&
        (selGroups.size > 0 || selCameras.size > 0);
      let linkErr = null;
      if (wantsLinks) {
        let newId = created && typeof created === 'object' ? created.id : null;
        if (!newId) {
          // Fallback: a API pode não retornar o usuário criado.
          try {
            const list = await usersApi.list();
            const found = (Array.isArray(list) ? list : []).find(
              (u) => u.username === username
            );
            newId = found ? found.id : null;
          } catch {
            newId = null;
          }
        }
        if (newId) {
          try {
            await usersApi.setGroups(newId, Array.from(selGroups));
            await usersApi.setCameras(newId, Array.from(selCameras));
          } catch (err) {
            linkErr = err;
          }
        } else {
          linkErr = new Error('id não encontrado');
        }
      }

      setShowCreate(false);
      setCreateForm(EMPTY_CREATE);
      if (linkErr) {
        toast.error(
          'Usuário criado, mas falhou ao aplicar grupos/câmeras. Edite o usuário para tentar de novo.'
        );
      } else {
        toast.success('Usuário criado.');
      }
      await loadUsers();
    } catch (err) {
      setCreateError(err.message || 'Falha ao criar usuário.');
    } finally {
      setCreating(false);
    }
  };

  // --- Editar (modal único) ---------------------------------------------------
  const openEdit = async (u) => {
    setEditing(u);
    setEditPassword('');
    setEditRole(u.role);
    setEditError('');
    resetLinks();
    setLinksLoading(true);
    try {
      const [groups, cams, detail] = await Promise.all([
        groupsApi.list(),
        camerasApi.list(),
        usersApi.get(u.id),
      ]);
      setAllGroups(Array.isArray(groups) ? groups : []);
      setAllCameras(Array.isArray(cams) ? cams : []);
      setSelGroups(new Set(detail.groupIds || []));
      setSelCameras(new Set(detail.cameraIds || []));
    } catch (err) {
      setLinksError(err.message || 'Falha ao carregar grupos e câmeras.');
    } finally {
      setLinksLoading(false);
    }
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    if (!editing) return;
    setEditError('');
    setEditSaving(true);
    try {
      // 1) Conta: role + senha (só envia o que mudou / foi preenchido).
      const patch = {};
      if (editPassword) patch.password = editPassword;
      if (editRole !== editing.role) patch.role = editRole;
      if (Object.keys(patch).length > 0) {
        await usersApi.update(editing.id, patch);
      }

      // 2) Vínculos (apenas viewer; pula se o catálogo nem carregou,
      //    para não zerar permissões por engano).
      const groupIds = Array.from(selGroups);
      const cameraIds = Array.from(selCameras);
      const applyLinks = editRole === 'viewer' && !linksError && !linksLoading;
      if (applyLinks) {
        await usersApi.setGroups(editing.id, groupIds);
        await usersApi.setCameras(editing.id, cameraIds);
      }

      setUsers((prev) =>
        prev.map((u) =>
          u.id === editing.id
            ? {
                ...u,
                role: editRole,
                ...(applyLinks
                  ? {
                      group_count: groupIds.length,
                      camera_count: cameraIds.length,
                    }
                  : {}),
              }
            : u
        )
      );
      setEditing(null);
      toast.success(
        editPassword
          ? 'Usuário atualizado (senha redefinida).'
          : 'Usuário atualizado.'
      );
    } catch (err) {
      setEditError(err.message || 'Falha ao salvar.');
    } finally {
      setEditSaving(false);
    }
  };

  // --- Excluir --------------------------------------------------------------
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await usersApi.remove(toDelete.id);
      setUsers((prev) => prev.filter((u) => u.id !== toDelete.id));
      toast.success('Usuário excluído.');
      setToDelete(null);
    } catch (err) {
      toast.error(err.message || 'Falha ao excluir.');
    } finally {
      setDeleting(false);
    }
  };

  // --- Seções de grupos/câmeras (compartilhadas entre criar e editar) --------
  const renderLinkSections = (role) =>
    role === 'admin' ? (
      <div className="modal-section">
        <h4 className="modal-section-title">Acesso às câmeras</h4>
        <p className="muted" style={{ margin: 0 }}>
          Administradores têm acesso total — veem todas as câmeras sem precisar
          de vínculos.
        </p>
      </div>
    ) : (
      <div className="modal-section">
        <h4 className="modal-section-title">Acesso às câmeras</h4>
        {linksLoading ? (
          <div className="centered-block" style={{ padding: '20px 0' }}>
            <div className="spinner small" />
          </div>
        ) : linksError ? (
          <div className="alert error">{linksError}</div>
        ) : (
          <>
            <div className="alert info" style={{ marginBottom: 14 }}>
              O usuário vê: <strong>câmeras dos grupos</strong> +{' '}
              <strong>câmeras avulsas</strong>.
            </div>
            <div className="perm-grid">
              <div className="perm-col">
                <h4 className="perm-title">
                  Grupos
                  <span className="count-pill">{selGroups.size}</span>
                </h4>
                <CheckListPicker
                  items={allGroups}
                  selected={selGroups}
                  onToggle={toggleSet(setSelGroups)}
                  query={groupQuery}
                  onQuery={setGroupQuery}
                  searchPlaceholder="Buscar grupo…"
                  emptyText="Nenhum grupo criado."
                  getName={(g) => g.name}
                  getSub={(g) =>
                    `${g.camera_count ?? 0} câmera${
                      (g.camera_count ?? 0) === 1 ? '' : 's'
                    }`
                  }
                />
              </div>
              <div className="perm-col">
                <h4 className="perm-title">
                  Câmeras avulsas
                  <span className="count-pill">{selCameras.size}</span>
                </h4>
                <CheckListPicker
                  items={allCameras}
                  selected={selCameras}
                  onToggle={toggleSet(setSelCameras)}
                  query={camQuery}
                  onQuery={setCamQuery}
                  searchPlaceholder="Buscar câmera…"
                  emptyText="Nenhuma câmera cadastrada."
                  getName={(c) => c.name}
                  getSub={(c) => c.location || ''}
                />
              </div>
            </div>
          </>
        )}
      </div>
    );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Usuários</h1>
          <p className="page-sub">Contas de acesso ao painel e às câmeras</p>
        </div>
        <button className="btn primary" onClick={openCreate}>
          <Icon name="plus" size={18} /> Novo usuário
        </button>
      </div>

      <section className="panel">
        <div className="panel-head-row">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Usuários
            {!loading && <span className="count-pill">{filtered.length}</span>}
          </h2>
          {!loading && !error && users.length > 0 && (
            <div className="head-actions">
              <div className="filter-tabs">
                {ROLE_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={`filter-tab ${
                      roleFilter === f.key ? 'active' : ''
                    }`}
                    onClick={() => setRoleFilter(f.key)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <SearchBar
                value={query}
                onChange={setQuery}
                placeholder="Buscar usuário…"
              />
            </div>
          )}
        </div>

        {loading && (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        )}
        {!loading && error && <div className="alert error">{error}</div>}

        {!loading && !error && users.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="user" size={40} />
            </span>
            <h2>Nenhum usuário cadastrado</h2>
            <p>Crie contas para conceder acesso ao painel e às câmeras.</p>
            <button className="btn primary" onClick={openCreate}>
              <Icon name="plus" size={18} /> Novo usuário
            </button>
          </div>
        )}

        {!loading && !error && users.length > 0 && filtered.length === 0 && (
          <p className="muted">Nenhum usuário corresponde aos filtros.</p>
        )}

        {!loading && !error && filtered.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Usuário</th>
                    <th>Papel</th>
                    <th>Grupos</th>
                    <th>Câmeras</th>
                    <th>Criado em</th>
                    <th className="col-actions">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.map((u) => {
                    const isSelf = me?.id === u.id;
                    return (
                      <tr key={u.id}>
                        <td data-label="Usuário">
                          <span className="cam-name">
                            <span className="user-mini-avatar">
                              {(u.username || '?').charAt(0).toUpperCase()}
                            </span>
                            {u.username}
                            {isSelf && <span className="self-tag">você</span>}
                          </span>
                        </td>
                        <td data-label="Papel">
                          <span
                            className={`role-pill ${
                              u.role === 'admin' ? 'admin' : 'viewer'
                            }`}
                          >
                            {u.role}
                          </span>
                        </td>
                        <td data-label="Grupos">
                          <span className="count-pill">
                            {u.group_count ?? 0}
                          </span>
                        </td>
                        <td data-label="Câmeras">
                          <span className="count-pill">
                            {u.camera_count ?? 0}
                          </span>
                        </td>
                        <td data-label="Criado em">{fmtDate(u.created_at)}</td>
                        <td className="col-actions" data-label="Ações">
                          <div className="row-actions">
                            <button
                              className="icon-btn"
                              title="Editar usuário (conta, grupos e câmeras)"
                              aria-label="Editar usuário"
                              onClick={() => openEdit(u)}
                            >
                              <Icon name="edit" size={16} />
                            </button>
                            {!isSelf && (
                              <button
                                className="icon-btn danger"
                                title="Excluir"
                                aria-label="Excluir"
                                onClick={() => setToDelete(u)}
                              >
                                <Icon name="trash" size={16} />
                              </button>
                            )}
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

      {/* Criar */}
      <Modal
        open={showCreate}
        title="Novo usuário"
        size="lg"
        onClose={() => (creating ? null : setShowCreate(false))}
        footer={
          <>
            <button
              className="btn ghost"
              onClick={() => setShowCreate(false)}
              disabled={creating}
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="create-user-form"
              className="btn primary"
              disabled={creating}
            >
              {creating ? 'Criando…' : 'Criar usuário'}
            </button>
          </>
        }
      >
        <form id="create-user-form" onSubmit={submitCreate}>
          <div className="modal-section">
            <h4 className="modal-section-title">Conta</h4>
            <div className="camera-form">
              <div className="form-row">
                <label className="field">
                  <span>Usuário</span>
                  <input
                    type="text"
                    value={createForm.username}
                    onChange={onCreateField('username')}
                    autoComplete="off"
                    autoFocus
                    required
                  />
                </label>
                <label className="field">
                  <span>Papel</span>
                  <select
                    className="select"
                    value={createForm.role}
                    onChange={onCreateField('role')}
                  >
                    <option value="viewer">viewer (apenas visualiza)</option>
                    <option value="admin">admin (acesso total)</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Senha</span>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={onCreateField('password')}
                  autoComplete="new-password"
                  required
                />
              </label>
            </div>
          </div>

          {renderLinkSections(createForm.role)}

          {createError && (
            <div className="alert error" style={{ marginTop: 16 }}>
              {createError}
            </div>
          )}
        </form>
      </Modal>

      {/* Editar — modal único: conta + grupos + câmeras */}
      <Modal
        open={!!editing}
        title={
          editing ? `Editar usuário — ${editing.username}` : 'Editar usuário'
        }
        size="lg"
        onClose={() => (editSaving ? null : setEditing(null))}
        footer={
          <>
            <button
              className="btn ghost"
              onClick={() => setEditing(null)}
              disabled={editSaving}
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="edit-user-form"
              className="btn primary"
              disabled={editSaving || linksLoading}
            >
              {editSaving ? 'Salvando…' : 'Salvar tudo'}
            </button>
          </>
        }
      >
        <form id="edit-user-form" onSubmit={submitEdit}>
          <div className="modal-section">
            <h4 className="modal-section-title">Conta</h4>
            <div className="camera-form">
              <div className="form-row">
                <label className="field">
                  <span>Usuário</span>
                  <input
                    type="text"
                    value={editing?.username || ''}
                    readOnly
                    disabled
                    title="O nome de usuário não pode ser alterado"
                  />
                </label>
                <label className="field">
                  <span>Papel</span>
                  <select
                    className="select"
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                  >
                    <option value="viewer">viewer (apenas visualiza)</option>
                    <option value="admin">admin (acesso total)</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Redefinir senha (opcional — em branco mantém a atual)</span>
                <input
                  type="password"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="••••••••"
                />
              </label>
            </div>
          </div>

          {renderLinkSections(editRole)}

          {editError && (
            <div className="alert error" style={{ marginTop: 16 }}>
              {editError}
            </div>
          )}
        </form>
      </Modal>

      {/* Excluir */}
      <ConfirmDialog
        open={!!toDelete}
        title="Excluir usuário"
        message={
          toDelete
            ? `Excluir o usuário "${toDelete.username}"? Esta ação não pode ser desfeita.`
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
