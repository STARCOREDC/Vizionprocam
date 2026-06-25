// =============================================================================
// Central API helper for VizionPro.
// Injeta Authorization: Bearer <token>, faz parse de JSON, e em 401
// limpa o token armazenado e força redirect para /login.
// Todas as URLs são relativas (mesmo domínio do backend Fastify, prefixo /api).
// =============================================================================

const TOKEN_KEY = 'vizionpro_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export { ApiError };

/**
 * Wrapper central de fetch.
 * @param {string} path  ex: '/api/cameras'
 * @param {object} options  opções padrão de fetch; `body` pode ser objeto simples
 */
export async function api(path, options = {}) {
  const { body, headers = {}, skipAuth = false, ...rest } = options;

  const finalHeaders = { ...headers };
  const token = getToken();
  if (token && !skipAuth) {
    finalHeaders['Authorization'] = `Bearer ${token}`;
  }

  let finalBody = body;
  if (body !== undefined && body !== null && typeof body === 'object') {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, { ...rest, headers: finalHeaders, body: finalBody });
  } catch (networkErr) {
    throw new ApiError('Falha de conexão com o servidor', 0, null);
  }

  // Trata expiração / token inválido globalmente.
  if (res.status === 401 && !skipAuth) {
    clearToken();
    if (window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
  }

  // Tenta parsear payload JSON (pode estar vazio).
  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    const text = await res.text();
    data = text || null;
  }

  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && data.error) ||
      (typeof data === 'string' && data) ||
      `Erro ${res.status}`;
    throw new ApiError(message, res.status, data);
  }

  return data;
}

// --- Endpoint helpers -------------------------------------------------------

export const authApi = {
  login: (username, password) =>
    api('/api/auth/login', {
      method: 'POST',
      body: { username, password },
      skipAuth: true,
    }),
  me: () => api('/api/auth/me', { method: 'GET' }),
  changePassword: (currentPassword, newPassword) =>
    api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
};

export const camerasApi = {
  list: () => api('/api/cameras', { method: 'GET' }),
  get: (id) => api(`/api/cameras/${id}`, { method: 'GET' }),
  create: ({
    name,
    rtsp_url,
    rtsp_url_sd,
    location,
    transcode,
    record,
    record_days,
    motion,
    onvif_port,
    ai_daily_limit,
    tamper_detect,
    audio_detect,
    audio_threshold_db,
    face_recognition,
  }) =>
    api('/api/cameras', {
      method: 'POST',
      body: {
        name,
        rtsp_url,
        rtsp_url_sd,
        location,
        transcode,
        record,
        record_days,
        motion,
        onvif_port,
        ai_daily_limit,
        tamper_detect,
        audio_detect,
        audio_threshold_db,
        face_recognition,
      },
    }),
  update: (id, body) =>
    api(`/api/cameras/${id}`, { method: 'PATCH', body }),
  remove: (id) => api(`/api/cameras/${id}`, { method: 'DELETE' }),
  recordings: (id) =>
    api(`/api/cameras/${id}/recordings`, { method: 'GET' }),
  testRtsp: (rtsp_url) =>
    api('/api/cameras/test-rtsp', { method: 'POST', body: { rtsp_url } }),
  onvifDetect: ({ ip, port, username, password }) =>
    api('/api/cameras/onvif-detect', {
      method: 'POST',
      body: { ip, port, username, password },
    }),
};

export const groupsApi = {
  list: () => api('/api/groups', { method: 'GET' }),
  get: (id) => api(`/api/groups/${id}`, { method: 'GET' }),
  create: (name) => api('/api/groups', { method: 'POST', body: { name } }),
  update: (id, name) =>
    api(`/api/groups/${id}`, { method: 'PATCH', body: { name } }),
  remove: (id) => api(`/api/groups/${id}`, { method: 'DELETE' }),
  setCameras: (id, cameraIds) =>
    api(`/api/groups/${id}/cameras`, { method: 'PUT', body: { cameraIds } }),
  setUsers: (id, userIds) =>
    api(`/api/groups/${id}/users`, { method: 'PUT', body: { userIds } }),
};

export const usersApi = {
  list: () => api('/api/users', { method: 'GET' }),
  get: (id) => api(`/api/users/${id}`, { method: 'GET' }),
  create: ({ username, password, role }) =>
    api('/api/users', { method: 'POST', body: { username, password, role } }),
  update: (id, patch) =>
    api(`/api/users/${id}`, { method: 'PATCH', body: patch }),
  remove: (id) => api(`/api/users/${id}`, { method: 'DELETE' }),
  setGroups: (id, groupIds) =>
    api(`/api/users/${id}/groups`, { method: 'PUT', body: { groupIds } }),
  setCameras: (id, cameraIds) =>
    api(`/api/users/${id}/cameras`, { method: 'PUT', body: { cameraIds } }),
};

export const statsApi = {
  get: () => api('/api/stats', { method: 'GET' }),
};

export const reportsApi = {
  summary: () => api('/api/reports/summary', { method: 'GET' }),
  uptime: (days = 30) => api(`/api/reports/uptime?days=${days}`),
  system: () => api('/api/reports/system'),
};

export const alertsApi = {
  list: () => api('/api/alerts', { method: 'GET' }),
  create: (body) => api('/api/alerts', { method: 'POST', body }),
  remove: (id) => api(`/api/alerts/${id}`, { method: 'DELETE' }),
};

export const presetsApi = {
  list: () => api('/api/detection-presets', { method: 'GET' }),
  create: (body) =>
    api('/api/detection-presets', { method: 'POST', body }),
  update: (id, body) =>
    api(`/api/detection-presets/${id}`, { method: 'PUT', body }),
  remove: (id) =>
    api(`/api/detection-presets/${id}`, { method: 'DELETE' }),
};

export const integrationsApi = {
  aiUsage: (days = 7) => api('/api/integrations/ai-usage?days=' + days),
  getWhatsApp: () => api('/api/integrations/whatsapp'),
  saveWhatsApp: (cfg) =>
    api('/api/integrations/whatsapp', { method: 'PUT', body: cfg }),
  testWhatsApp: (text) =>
    api('/api/integrations/whatsapp/test', { method: 'POST', body: { text } }),
  fetchGroups: (cfg) =>
    api('/api/integrations/whatsapp/groups', { method: 'POST', body: cfg || {} }),
  getGemini: () => api('/api/integrations/gemini'),
  saveGemini: (cfg) =>
    api('/api/integrations/gemini', { method: 'PUT', body: cfg }),
  testGemini: (cfg) =>
    api('/api/integrations/gemini/test', { method: 'POST', body: cfg || {} }),
  // Relatório inteligente automático (resumo das detecções via WhatsApp).
  getReport: () => api('/api/integrations/report'),
  saveReport: (cfg) =>
    api('/api/integrations/report', { method: 'PUT', body: cfg }),
  testReport: () =>
    api('/api/integrations/report/test', { method: 'POST' }),
};
