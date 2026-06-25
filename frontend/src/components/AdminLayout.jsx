import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Sidebar from './Sidebar.jsx';

const COLLAPSE_KEY = 'vizionpro_sidebar_collapsed';

/**
 * Layout das rotas autenticadas: sidebar colapsável + topbar.
 * As páginas renderizam dentro de <Outlet />.
 */
export default function AdminLayout() {
  const { user, logout } = useAuth();

  // Estado do colapso (só-ícones) persistido em localStorage.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === '1'
  );
  // Off-canvas para telas pequenas.
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // O hambúrguer alterna colapso no desktop e o off-canvas no mobile.
  const onHamburger = () => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setMobileOpen((v) => !v);
    } else {
      setCollapsed((v) => !v);
    }
  };

  return (
    <div className={`layout ${collapsed ? 'is-collapsed' : ''}`}>
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapse={onHamburger}
        onCloseMobile={() => setMobileOpen(false)}
      />

      {/* Overlay do off-canvas em telas pequenas */}
      {mobileOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="layout-main">
        <header className="topbar">
          <button
            type="button"
            className="topbar-burger"
            aria-label="Abrir menu"
            onClick={onHamburger}
          >
            <span />
            <span />
            <span />
          </button>

          <div className="topbar-spacer" />

          <div className="topbar-right">
            <span className="user-chip">
              <span className="user-avatar">
                {(user?.username || '?').charAt(0).toUpperCase()}
              </span>
              <span className="user-meta">
                <span className="user-name">{user?.username}</span>
                <span className="user-role">{user?.role}</span>
              </span>
            </span>
            <button className="btn ghost" onClick={logout}>
              Sair
            </button>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
