import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Icon from './Icon.jsx';

// Itens do menu. adminOnly => só aparece para role 'admin'.
const NAV_ITEMS = [
  { to: '/', icon: 'dashboard', label: 'Ao vivo', end: true, adminOnly: false },
  { to: '/cameras', icon: 'camera', label: 'Câmeras', adminOnly: true },
  { to: '/grupos', icon: 'group', label: 'Grupos', adminOnly: true },
  { to: '/usuarios', icon: 'user', label: 'Usuários', adminOnly: true },
  { to: '/gravacoes', icon: 'recordings', label: 'Gravações', adminOnly: true },
  { to: '/mosaico', icon: 'mosaic', label: 'Mosaico', adminOnly: true },
  { to: '/relatorios', icon: 'reports', label: 'Relatórios', adminOnly: true },
  { to: '/disponibilidade', icon: 'activity', label: 'Disponibilidade', adminOnly: true },
  { to: '/sistema', icon: 'server', label: 'Sistema', adminOnly: true },
  { to: '/alertas', icon: 'alerts', label: 'Alertas', adminOnly: true },
  { to: '/armazenamento', icon: 'database', label: 'Armazenamento', adminOnly: true },
  { to: '/deteccao-ia', icon: 'cpu', label: 'Detecção IA', adminOnly: true },
  { to: '/integracoes', icon: 'plug', label: 'Integrações', adminOnly: true },
  { to: '/config', icon: 'settings', label: 'Configurações', adminOnly: true },
];

/**
 * Menu lateral colapsável.
 * Props:
 *  - collapsed:    boolean (modo só-ícones em desktop)
 *  - mobileOpen:   boolean (off-canvas aberto em telas pequenas)
 *  - onToggleCollapse: alterna colapso (botão hambúrguer)
 *  - onCloseMobile:    fecha o off-canvas (ao clicar num item / overlay)
 */
export default function Sidebar({
  collapsed,
  mobileOpen,
  onToggleCollapse,
  onCloseMobile,
}) {
  const { isAdmin } = useAuth();

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <aside
      className={`sidebar ${collapsed ? 'collapsed' : ''} ${
        mobileOpen ? 'mobile-open' : ''
      }`}
    >
      <div className="sidebar-head">
        <button
          type="button"
          className="hamburger"
          aria-label={collapsed ? 'Expandir menu' : 'Encolher menu'}
          onClick={onToggleCollapse}
        >
          <span />
          <span />
          <span />
        </button>
        <span className="sidebar-brand">
          <img className="sidebar-logo-full" src="/logo.png" alt="VizionPro" />
          <img className="sidebar-logo-icon" src="/logo-icon.png" alt="VizionPro" />
        </span>
      </div>

      <nav className="sidebar-nav">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `side-link ${isActive ? 'active' : ''}`
            }
            onClick={onCloseMobile}
            title={collapsed ? item.label : undefined}
          >
            <span className="side-icon" aria-hidden="true">
              <Icon name={item.icon} size={20} />
            </span>
            <span className="side-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <span className="side-foot-text">Central de monitoramento</span>
      </div>
    </aside>
  );
}
