import { useEffect, useMemo, useState } from 'react';
import { groupsApi, camerasApi, usersApi } from '../api.js';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import SearchBar from '../components/SearchBar.jsx';
import Pagination from '../components/Pagination.jsx';
import Icon from '../components/Icon.jsx';
import { usePaginated } from '../hooks/usePaginated.js';
import { useToast } from '../components/Toast.jsx';

const PAGE_SIZE = 20;

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

export default function Grupos() {
  const toast = useToast();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Busca na lista.
  const [query, setQuery] = useState('');

  // Criar / renomear (modal compartilhado).
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // null => criar
  const [nameValue, setNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Excluir.
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Gerir câmeras do grupo (modal).
  const [managing, setManaging] = useState(null); // grupo
  const [allCameras, setAllCameras] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [manageLoading, setManageLoading] = useState(false);
  const [manageSaving, setManageSaving] = useState(false);
  const [manageError, setManageError] = useState('');
  const [camQuery, setCamQuery] = useState('');

  // Gerir usuários do grupo (modal).
  const [managingUsers, setManagingUsers] = useState(null); // grupo
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUserIds, setSelectedUserIds] = useState(new Set());
  const [muLoading, setMuLoading] = useState(false);
  const [muSaving, setMuSaving] = useState(false);
  const [muError, setMuError] = useState('');
  const [userQuery, setUserQuery] = useState('');

  const loadGroups = async () => {
    setError('');
    try {
      const list = await groupsApi.list();
      setGroups(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || 'Falha ao carregar grupos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGroups();
  }, []);

  // --- Filtro + paginação ---------------------------------------------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => (g.name || '').toLowerCase().includes(q));
  }, [groups, query]);

  const { page, setPage, slice } = usePaginated(filtered, PAGE_SIZE);

  // --- Criar / Renomear -----------------------------------------------------
  const openCreate = () => {
    setEditing(null);
    setNameValue('');
    setFormOpen(true);
  };
  const openRename = (g) => {
    setEditing(g);
    setNameValue(g.name);
    setFormOpen(true);
  };

  const saveName = async (e) => {
    e.preventDefault();
    const name = nameValue.trim();
    if (!name) return;
    setSavingName(true);
    try {
      if (editing) {
        await groupsApi.update(editing.id, name);
        setGroups((prev) =>
          prev.map((g) => (g.id === editing.id ? { ...g, name } : g))
        );
        toast.success('Grupo renomeado.');
      } else {
        await groupsApi.create(name);
        toast.success('Grupo criado.');
        await loadGroups();
      }
      setFormOpen(false);
    } catch (err) {
      toast.error(err.message || 'Falha ao salvar grupo.');
    } finally {
      setSavingName(false);
    }
  };

  // --- Excluir --------------------------------------------------------------
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await groupsApi.remove(toDelete.id);
      setGroups((prev) => prev.filter((g) => g.id !== toDelete.id));
      toast.success('Grupo excluído.');
      setToDelete(null);
    } catch (err) {
      toast.error(err.message || 'Falha ao excluir.');
    } finally {
      setDeleting(false);
    }
  };

  // --- Gerir câmeras --------------------------------------------------------
  const openManage = async (g) => {
    setManaging(g);
    setManageError('');
    setManageLoading(true);
    setSelectedIds(new Set());
    setCamQuery('');
    try {
      const [cams, detail] = await Promise.all([
        camerasApi.list(),
        groupsApi.get(g.id),
      ]);
      setAllCameras(Array.isArray(cams) ? cams : []);
      setSelectedIds(new Set(detail.cameraIds || []));
    } catch (err) {
      setManageError(err.message || 'Falha ao carregar câmeras.');
    } finally {
      setManageLoading(false);
    }
  };

  const toggleCamera = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredCams = useMemo(() => {
    const q = camQuery.trim().toLowerCase();
    if (!q) return allCameras;
    return allCameras.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.location || '').toLowerCase().includes(q)
    );
  }, [allCameras, camQuery]);

  // --- Gerir usuários -------------------------------------------------------
  const openManageUsers = async (g) => {
    setManagingUsers(g);
    setMuError('');
    setMuLoading(true);
    setSelectedUserIds(new Set());
    setUserQuery('');
    try {
      const [users, detail] = await Promise.all([
        usersApi.list(),
        groupsApi.get(g.id),
      ]);
      setAllUsers(Array.isArray(users) ? users : []);
      setSelectedUserIds(new Set(detail.userIds || []));
    } catch (err) {
      setMuError(err.message || 'Falha ao carregar usuários.');
    } finally {
      setMuLoading(false);
    }
  };

  const toggleUser = (id) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return allUsers;
    return allUsers.filter((u) => (u.username || '').toLowerCase().includes(q));
  }, [allUsers, userQuery]);

  const saveUsers = async () => {
    setMuSaving(true);
    setMuError('');
    try {
      const ids = Array.from(selectedUserIds);
      await groupsApi.setUsers(managingUsers.id, ids);
      const names = allUsers
        .filter((u) => selectedUserIds.has(u.id))
        .map((u) => u.username);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === managingUsers.id
            ? { ...g, user_count: ids.length, user_names: names }
            : g
        )
      );
      toast.success('Usuários do grupo atualizados.');
      setManagingUsers(null);
    } catch (err) {
      setMuError(err.message || 'Falha ao salvar.');
    } finally {
      setMuSaving(false);
    }
  };

  const saveCameras = async () => {
    setManageSaving(true);
    setManageError('');
    try {
      const ids = Array.from(selectedIds);
      await groupsApi.setCameras(managing.id, ids);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === managing.id ? { ...g, camera_count: ids.length } : g
        )
      );
      toast.success('Câmeras do grupo atualizadas.');
      setManaging(null);
    } catch (err) {
      setManageError(err.message || 'Falha ao salvar.');
    } finally {
      setManageSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Grupos</h1>
          <p className="page-sub">
            Um grupo junta câmeras. Usuários vinculados ao grupo veem todas as
            câmeras dele.
          </p>
        </div>
        <button className="btn primary" onClick={openCreate}>
          <Icon name="plus" size={18} /> Novo grupo
        </button>
      </div>

      <section className="panel">
        <div className="panel-head-row">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Grupos
            {!loading && <span className="count-pill">{filtered.length}</span>}
          </h2>
          {!loading && !error && groups.length > 0 && (
            <SearchBar
              value={query}
              onChange={setQuery}
              placeholder="Buscar grupo…"
            />
          )}
        </div>

        {loading && (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        )}
        {!loading && error && <div className="alert error">{error}</div>}

        {!loading && !error && groups.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="group" size={40} />
            </span>
            <h2>Nenhum grupo criado</h2>
            <p>Crie grupos para organizar câmeras e conceder acessos em lote.</p>
            <button className="btn primary" onClick={openCreate}>
              <Icon name="plus" size={18} /> Novo grupo
            </button>
          </div>
        )}

        {!loading && !error && groups.length > 0 && filtered.length === 0 && (
          <p className="muted">Nenhum grupo corresponde à busca.</p>
        )}

        {!loading && !error && filtered.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Câmeras</th>
                    <th>Usuários</th>
                    <th>Criado em</th>
                    <th className="col-actions">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.map((g) => {
                    const names = Array.isArray(g.user_names)
                      ? g.user_names
                      : [];
                    return (
                    <tr key={g.id}>
                      <td data-label="Nome">
                        <span className="cam-name">
                          <Icon name="group" size={16} /> {g.name}
                        </span>
                      </td>
                      <td data-label="Câmeras">
                        <span className="count-pill">
                          {g.camera_count ?? 0}
                        </span>
                      </td>
                      <td data-label="Usuários">
                        <span className="cell-chips">
                          <span className="count-pill">
                            {g.user_count ?? names.length}
                          </span>
                          {names.slice(0, 3).map((n) => (
                            <span className="name-chip" key={n} title={n}>
                              {n}
                            </span>
                          ))}
                          {names.length > 3 && (
                            <span
                              className="name-chip more"
                              title={names.slice(3).join(', ')}
                            >
                              +{names.length - 3}
                            </span>
                          )}
                        </span>
                      </td>
                      <td data-label="Criado em">{fmtDate(g.created_at)}</td>
                      <td className="col-actions" data-label="Ações">
                        <div className="row-actions">
                          <button
                            className="btn ghost small"
                            onClick={() => openManage(g)}
                          >
                            <Icon name="camera" size={15} /> Câmeras
                          </button>
                          <button
                            className="btn ghost small"
                            onClick={() => openManageUsers(g)}
                          >
                            <Icon name="user" size={15} /> Usuários
                          </button>
                          <button
                            className="icon-btn"
                            title="Renomear"
                            aria-label="Renomear"
                            onClick={() => openRename(g)}
                          >
                            <Icon name="edit" size={16} />
                          </button>
                          <button
                            className="icon-btn danger"
                            title="Excluir"
                            aria-label="Excluir"
                            onClick={() => setToDelete(g)}
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

      {/* Criar / Renomear */}
      <Modal
        open={formOpen}
        title={editing ? 'Renomear grupo' : 'Novo grupo'}
        size="sm"
        onClose={() => (savingName ? null : setFormOpen(false))}
        footer={
          <>
            <button
              className="btn ghost"
              onClick={() => setFormOpen(false)}
              disabled={savingName}
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="group-form"
              className="btn primary"
              disabled={savingName || !nameValue.trim()}
            >
              {savingName ? 'Salvando…' : editing ? 'Salvar' : 'Criar grupo'}
            </button>
          </>
        }
      >
        <form id="group-form" onSubmit={saveName}>
          <label className="field">
            <span>Nome do grupo</span>
            <input
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              placeholder="Ex: Filial Centro"
              autoFocus
              required
            />
          </label>
        </form>
      </Modal>

      {/* Gerir câmeras */}
      <Modal
        open={!!managing}
        title={managing ? `Câmeras — ${managing.name}` : 'Câmeras do grupo'}
        onClose={() => (manageSaving ? null : setManaging(null))}
        footer={
          <>
            <button
              className="btn ghost"
              onClick={() => setManaging(null)}
              disabled={manageSaving}
            >
              Cancelar
            </button>
            <button
              className="btn primary"
              onClick={saveCameras}
              disabled={manageSaving || manageLoading}
            >
              {manageSaving ? 'Salvando…' : 'Salvar câmeras'}
            </button>
          </>
        }
      >
        {manageLoading ? (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        ) : manageError ? (
          <div className="alert error">{manageError}</div>
        ) : allCameras.length === 0 ? (
          <p className="muted">Nenhuma câmera cadastrada.</p>
        ) : (
          <>
            <div className="manage-head">
              <p className="muted" style={{ margin: 0 }}>
                Marque as câmeras deste grupo.
              </p>
              <span className="count-pill">
                {selectedIds.size} selecionada
                {selectedIds.size === 1 ? '' : 's'}
              </span>
            </div>
            {allCameras.length > 6 && (
              <div style={{ margin: '12px 0' }}>
                <SearchBar
                  value={camQuery}
                  onChange={setCamQuery}
                  placeholder="Buscar câmera…"
                />
              </div>
            )}
            {filteredCams.length === 0 ? (
              <p className="muted">Nenhuma câmera corresponde à busca.</p>
            ) : (
              <div className="check-list">
                {filteredCams.map((cam) => (
                  <label className="check-item" key={cam.id}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(cam.id)}
                      onChange={() => toggleCamera(cam.id)}
                    />
                    <span className="check-item-main">
                      <span className="check-item-name">{cam.name}</span>
                      {cam.location && (
                        <span className="check-item-sub">{cam.location}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Gerir usuários */}
      <Modal
        open={!!managingUsers}
        title={
          managingUsers
            ? `Usuários — ${managingUsers.name}`
            : 'Usuários do grupo'
        }
        onClose={() => (muSaving ? null : setManagingUsers(null))}
        footer={
          <>
            <button
              className="btn ghost"
              onClick={() => setManagingUsers(null)}
              disabled={muSaving}
            >
              Cancelar
            </button>
            <button
              className="btn primary"
              onClick={saveUsers}
              disabled={muSaving || muLoading}
            >
              {muSaving ? 'Salvando…' : 'Salvar usuários'}
            </button>
          </>
        }
      >
        {muLoading ? (
          <div className="centered-block">
            <div className="spinner" />
          </div>
        ) : muError ? (
          <div className="alert error">{muError}</div>
        ) : allUsers.length === 0 ? (
          <p className="muted">Nenhum usuário cadastrado.</p>
        ) : (
          <>
            <div className="manage-head">
              <p className="muted" style={{ margin: 0 }}>
                Marque quem deve ver as câmeras deste grupo.
              </p>
              <span className="count-pill">
                {selectedUserIds.size} selecionado
                {selectedUserIds.size === 1 ? '' : 's'}
              </span>
            </div>
            {allUsers.length > 6 && (
              <div style={{ margin: '12px 0' }}>
                <SearchBar
                  value={userQuery}
                  onChange={setUserQuery}
                  placeholder="Buscar usuário…"
                />
              </div>
            )}
            {filteredUsers.length === 0 ? (
              <p className="muted">Nenhum usuário corresponde à busca.</p>
            ) : (
              <div className="check-list">
                {filteredUsers.map((u) => (
                  <label className="check-item" key={u.id}>
                    <input
                      type="checkbox"
                      checked={selectedUserIds.has(u.id)}
                      onChange={() => toggleUser(u.id)}
                    />
                    <span className="check-item-main">
                      <span className="check-item-name">{u.username}</span>
                      <span className="check-item-sub">{u.role}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Excluir */}
      <ConfirmDialog
        open={!!toDelete}
        title="Excluir grupo"
        message={
          toDelete
            ? `Excluir o grupo "${toDelete.name}"? Os usuários perderão o acesso concedido por ele.`
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
