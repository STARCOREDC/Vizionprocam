import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './auth.jsx';
import AdminLayout from './components/AdminLayout.jsx';
import Login from './pages/Login.jsx';
import GuestView from './pages/GuestView.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CamerasAdmin from './pages/CamerasAdmin.jsx';
import Grupos from './pages/Grupos.jsx';
import Usuarios from './pages/Usuarios.jsx';
import Gravacoes from './pages/Gravacoes.jsx';
import Mosaico from './pages/Mosaico.jsx';
import Relatorios from './pages/Relatorios.jsx';
import Disponibilidade from './pages/Disponibilidade.jsx';
import Sistema from './pages/Sistema.jsx';
import Armazenamento from './pages/Armazenamento.jsx';
import Alertas from './pages/Alertas.jsx';
import Integracoes from './pages/Integracoes.jsx';
import DeteccaoIA from './pages/DeteccaoIA.jsx';
import Config from './pages/Config.jsx';

export default function App() {
  return (
    <Routes>
      {/* Login fica fora do layout */}
      <Route path="/login" element={<Login />} />

      {/* Convidado: visualização pública por link temporário (sem login) */}
      <Route path="/guest/:token" element={<GuestView />} />

      {/* Rotas autenticadas dentro do AdminLayout (sidebar + topbar) */}
      <Route
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        {/* Ao vivo — todos os autenticados */}
        <Route path="/" element={<Dashboard />} />

        {/* Áreas admin */}
        <Route
          path="/cameras"
          element={
            <ProtectedRoute requireAdmin>
              <CamerasAdmin />
            </ProtectedRoute>
          }
        />
        <Route
          path="/grupos"
          element={
            <ProtectedRoute requireAdmin>
              <Grupos />
            </ProtectedRoute>
          }
        />
        <Route
          path="/usuarios"
          element={
            <ProtectedRoute requireAdmin>
              <Usuarios />
            </ProtectedRoute>
          }
        />
        <Route
          path="/gravacoes"
          element={
            <ProtectedRoute requireAdmin>
              <Gravacoes />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mosaico"
          element={
            <ProtectedRoute requireAdmin>
              <Mosaico />
            </ProtectedRoute>
          }
        />
        <Route
          path="/relatorios"
          element={
            <ProtectedRoute requireAdmin>
              <Relatorios />
            </ProtectedRoute>
          }
        />
        <Route
          path="/disponibilidade"
          element={
            <ProtectedRoute requireAdmin>
              <Disponibilidade />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sistema"
          element={
            <ProtectedRoute requireAdmin>
              <Sistema />
            </ProtectedRoute>
          }
        />
        <Route
          path="/armazenamento"
          element={
            <ProtectedRoute requireAdmin>
              <Armazenamento />
            </ProtectedRoute>
          }
        />
        <Route
          path="/alertas"
          element={
            <ProtectedRoute requireAdmin>
              <Alertas />
            </ProtectedRoute>
          }
        />
        <Route
          path="/integracoes"
          element={
            <ProtectedRoute requireAdmin>
              <Integracoes />
            </ProtectedRoute>
          }
        />
        <Route
          path="/deteccao-ia"
          element={
            <ProtectedRoute requireAdmin>
              <DeteccaoIA />
            </ProtectedRoute>
          }
        />
        <Route
          path="/config"
          element={
            <ProtectedRoute requireAdmin>
              <Config />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
