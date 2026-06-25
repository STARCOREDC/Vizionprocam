import { useEffect, useState } from 'react';
import { integrationsApi } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Icon from '../components/Icon.jsx';

// Config padrão (vazia) usada antes do carregamento e como fallback.
const EMPTY = {
  enabled: false,
  baseUrl: '',
  instance: '',
  apiKey: '',
  target: '',
  targetName: '',
};

// Config padrão da IA (Gemini).
const EMPTY_GEMINI = {
  configured: false,
  enabled: false,
  model: 'gemini-2.0-flash',
  mode: 'pessoas',
  apiKey: '', // sempre vazio no form — vazio = mantém a chave salva
  apiKeyMasked: '',
};

// Config padrão do relatório automático (resumo das detecções no WhatsApp).
const EMPTY_REPORT = {
  enabled: false,
  frequency: 'daily', // 'daily' | 'weekly' (semanal = toda segunda)
  time: '08:00', // HH:MM
  target: '', // vazio = usa o destino padrão do WhatsApp
  useAI: false, // usa o Gemini para redigir o texto
  last_sent: null, // ISO string do último envio (read-only)
};

export default function Integracoes() {
  const toast = useToast();

  const [cfg, setCfg] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // Resultado do "Testar envio".
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, message }

  // Busca de grupos da Evolution para o dropdown de Destino.
  const [groups, setGroups] = useState([]); // [{ id, name }]
  const [fetchingGroups, setFetchingGroups] = useState(false);
  const [groupsError, setGroupsError] = useState('');
  const [manualTarget, setManualTarget] = useState(false);

  // --- IA (Google Gemini) --------------------------------------------------
  const [gem, setGem] = useState(EMPTY_GEMINI);
  const [gemSaving, setGemSaving] = useState(false);
  const [gemTesting, setGemTesting] = useState(false);
  const [gemShowKey, setGemShowKey] = useState(false);
  const [gemTestResult, setGemTestResult] = useState(null); // { ok, label, description, message }

  // --- Relatório automático (resumo das detecções no WhatsApp) -------------
  const [rep, setRep] = useState(EMPTY_REPORT);
  const [repSaving, setRepSaving] = useState(false);
  const [repTesting, setRepTesting] = useState(false);
  const [repTestResult, setRepTestResult] = useState(null); // { ok, sent, preview, message }

  useEffect(() => {
    let cancelled = false;
    integrationsApi
      .getWhatsApp()
      .then((res) => {
        if (!cancelled) setCfg({ ...EMPTY, ...(res || {}) });
      })
      .catch((err) => {
        if (!cancelled)
          setLoadError(err.message || 'Falha ao carregar a configuração do WhatsApp.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Carrega a config da IA (Gemini) no mount. A apiKey real nunca volta;
  // usamos apiKeyMasked apenas como placeholder no input.
  useEffect(() => {
    let cancelled = false;
    integrationsApi
      .getGemini()
      .then((res) => {
        if (!cancelled) setGem({ ...EMPTY_GEMINI, ...(res || {}), apiKey: '' });
      })
      .catch(() => {
        // silencioso — a seção mostra os defaults se falhar
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateGem = (key) => (e) => {
    const value = e?.target?.type === 'checkbox' ? e.target.checked : e.target.value;
    setGem((prev) => ({ ...prev, [key]: value }));
    setGemTestResult(null);
  };

  // Monta o payload enviado ao backend a partir do form atual.
  const gemPayload = () => ({
    apiKey: gem.apiKey, // vazio = mantém a chave salva
    model: (gem.model || '').trim() || 'gemini-2.0-flash',
    enabled: !!gem.enabled,
    mode: gem.mode || 'pessoas',
  });

  const onSaveGemini = async (e) => {
    e.preventDefault();
    setGemSaving(true);
    setGemTestResult(null);
    try {
      const saved = await integrationsApi.saveGemini(gemPayload());
      if (saved && typeof saved === 'object') {
        // Mantém a apiKey do form vazia (não recebemos a chave de volta).
        setGem((prev) => ({ ...prev, ...saved, apiKey: '' }));
      }
      toast.success('Configuração da IA salva com sucesso.');
    } catch (err) {
      toast.error(err.message || 'Não foi possível salvar a IA.');
    } finally {
      setGemSaving(false);
    }
  };

  const onTestGemini = async () => {
    setGemTesting(true);
    setGemTestResult(null);
    try {
      const res = await integrationsApi.testGemini(gemPayload());
      if (res && res.ok) {
        setGemTestResult({
          ok: true,
          label: res.label || '',
          description: res.description || '',
        });
        toast.success('Conexão com a IA funcionou!');
      } else {
        const detail = (res && res.error) || 'falha desconhecida';
        setGemTestResult({ ok: false, message: detail });
        toast.error(`Falha no teste: ${detail}`);
      }
    } catch (err) {
      const data = err?.data;
      const detail =
        (data && typeof data === 'object' && data.error) ||
        err?.message ||
        'falha desconhecida';
      setGemTestResult({ ok: false, message: detail });
      toast.error(`Falha no teste: ${detail}`);
    } finally {
      setGemTesting(false);
    }
  };

  // Carrega a config do relatório automático no mount. Silencioso em erro:
  // a seção apenas exibe os defaults se a chamada falhar.
  useEffect(() => {
    let cancelled = false;
    integrationsApi
      .getReport()
      .then((res) => {
        if (!cancelled) setRep({ ...EMPTY_REPORT, ...(res || {}) });
      })
      .catch(() => {
        /* silencioso — mantém defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateRep = (key) => (e) => {
    const value = e?.target?.type === 'checkbox' ? e.target.checked : e.target.value;
    setRep((prev) => ({ ...prev, [key]: value }));
    setRepTestResult(null);
  };

  // Seleção de grupo do dropdown (reaproveita os grupos buscados da Evolution).
  const onSelectReportGroup = (e) => {
    const id = e.target.value; // '' = usar destino padrão do WhatsApp
    setRep((prev) => ({ ...prev, target: id }));
    setRepTestResult(null);
  };

  const onSaveReport = async (e) => {
    e.preventDefault();
    setRepSaving(true);
    setRepTestResult(null);
    try {
      const saved = await integrationsApi.saveReport({
        enabled: !!rep.enabled,
        frequency: rep.frequency === 'weekly' ? 'weekly' : 'daily',
        time: (rep.time || '').trim() || '08:00',
        target: (rep.target || '').trim(),
        useAI: !!rep.useAI,
      });
      if (saved && typeof saved === 'object') {
        setRep((prev) => ({ ...prev, ...saved }));
      }
      toast.success('Relatório automático salvo com sucesso.');
    } catch (err) {
      toast.error(err.message || 'Não foi possível salvar o relatório.');
    } finally {
      setRepSaving(false);
    }
  };

  // Gera e ENVIA um relatório de teste agora; mostra o texto gerado (preview).
  const onTestReport = async () => {
    setRepTesting(true);
    setRepTestResult(null);
    try {
      const res = await integrationsApi.testReport();
      if (res && res.ok) {
        setRepTestResult({
          ok: true,
          sent: !!res.sent,
          preview: res.preview || '',
        });
        toast.success(
          res.sent ? 'Relatório de teste enviado!' : 'Relatório gerado (não enviado).'
        );
      } else {
        const detail = (res && res.error) || 'falha desconhecida';
        setRepTestResult({ ok: false, preview: (res && res.preview) || '', message: detail });
        toast.error(`Falha no relatório: ${detail}`);
      }
    } catch (err) {
      const data = err?.data;
      const detail =
        (data && typeof data === 'object' && data.error) ||
        err?.message ||
        'falha desconhecida';
      setRepTestResult({ ok: false, preview: '', message: detail });
      toast.error(`Falha no relatório: ${detail}`);
    } finally {
      setRepTesting(false);
    }
  };

  // Formata o ISO de last_sent para exibição amigável (pt-BR), com fallback.
  const formatLastSent = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  };

  const update = (key) => (e) => {
    const value = e?.target?.type === 'checkbox' ? e.target.checked : e.target.value;
    setCfg((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setTestResult(null);
    try {
      const saved = await integrationsApi.saveWhatsApp({
        enabled: !!cfg.enabled,
        baseUrl: cfg.baseUrl.trim(),
        instance: cfg.instance.trim(),
        apiKey: cfg.apiKey,
        target: cfg.target.trim(),
        targetName: cfg.targetName.trim(),
      });
      if (saved && typeof saved === 'object') {
        setCfg((prev) => ({ ...prev, ...saved }));
      }
      toast.success('Integração salva com sucesso.');
    } catch (err) {
      toast.error(err.message || 'Não foi possível salvar a integração.');
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await integrationsApi.testWhatsApp(
        'VizionPro: mensagem de teste da integração com WhatsApp.'
      );
      if (res && res.ok) {
        setTestResult({ ok: true, message: 'Mensagem enviada!' });
      } else {
        // Backend retornou {ok:false, error/status/body}
        const detail =
          (res && (res.error || res.body)) ||
          (res && res.status ? `status ${res.status}` : '') ||
          'falha desconhecida';
        setTestResult({ ok: false, message: `Falha no envio: ${detail}` });
      }
    } catch (err) {
      // ApiError carrega .data com o payload do backend, quando houver.
      const data = err?.data;
      const detail =
        (data && typeof data === 'object' && (data.error || data.body)) ||
        err?.message ||
        'falha desconhecida';
      setTestResult({ ok: false, message: `Falha no envio: ${detail}` });
    } finally {
      setTesting(false);
    }
  };

  // Traduz erros comuns da Evolution numa mensagem amigável.
  const friendlyGroupsError = (error) => {
    const raw = (error || '').toString();
    if (/401|unauthor/i.test(raw)) {
      return 'API Key inválida. Confira a URL, a instância e a API Key.';
    }
    if (/404/i.test(raw)) {
      return 'Instância não encontrada. Confira a URL e o nome da instância.';
    }
    if (/ECONN|fetch|network|conex|timeout|ETIMEDOUT/i.test(raw)) {
      return 'Não foi possível conectar à Evolution. Confira a URL.';
    }
    return `${raw || 'Falha ao buscar grupos.'} — confira URL/instância/API Key.`;
  };

  const onFetchGroups = async () => {
    setFetchingGroups(true);
    setGroupsError('');
    try {
      const res = await integrationsApi.fetchGroups({
        baseUrl: cfg.baseUrl.trim(),
        instance: cfg.instance.trim(),
        apiKey: cfg.apiKey,
      });
      if (res && res.ok) {
        const list = Array.isArray(res.groups) ? res.groups : [];
        setGroups(list);
        setManualTarget(false);
        if (list.length === 0) {
          setGroupsError('Nenhum grupo encontrado nesta instância.');
          toast.info('Nenhum grupo encontrado.');
        } else {
          toast.success(`${list.length} grupo(s) encontrado(s).`);
        }
      } else {
        const msg = friendlyGroupsError(res && (res.error || res.body));
        setGroupsError(msg);
        toast.error(msg);
      }
    } catch (err) {
      const data = err?.data;
      const detail =
        (data && typeof data === 'object' && (data.error || data.body)) ||
        err?.status ||
        err?.message;
      const msg = friendlyGroupsError(detail);
      setGroupsError(msg);
      toast.error(msg);
    } finally {
      setFetchingGroups(false);
    }
  };

  const onSelectGroup = (e) => {
    const id = e.target.value;
    if (!id) return;
    const g = groups.find((grp) => grp.id === id);
    setCfg((prev) => ({
      ...prev,
      target: id,
      targetName: g ? g.name : prev.targetName,
    }));
    setTestResult(null);
  };

  if (loading) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Integrações</h1>
            <p className="page-sub">Conecte o VizionPro a serviços externos</p>
          </div>
        </div>
        <div className="centered-block" style={{ padding: '48px 0' }}>
          <div className="spinner" />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Integrações</h1>
          <p className="page-sub">Conecte o VizionPro a serviços externos</p>
        </div>
      </div>

      {loadError && (
        <div className="alert error" style={{ marginBottom: 22 }}>
          {loadError}
        </div>
      )}

      {/* === Card explicativo ============================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="plug" size={18} /> WhatsApp · Evolution API
        </h2>
        <div className="alert info" style={{ marginBottom: 4 }}>
          Conecte sua <strong>Evolution API</strong> para enviar alertas (ex: câmera
          offline) para um grupo de WhatsApp.
        </div>
      </section>

      {/* === Formulário =================================================== */}
      <section className="panel">
        <form className="camera-form" onSubmit={onSave}>
          {/* Ativar */}
          <div className="switch-row">
            <span className="switch-text">
              <strong>Ativar integração</strong>
              <span className="field-hint">
                Quando desligada, nenhum alerta é enviado por WhatsApp.
              </span>
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={!!cfg.enabled}
                onChange={update('enabled')}
              />
              <span className="slider" />
            </label>
          </div>

          {/* URL da Evolution */}
          <label className="field">
            <span>URL da Evolution</span>
            <input
              type="text"
              value={cfg.baseUrl}
              onChange={update('baseUrl')}
              placeholder="http://IP:8080"
              autoComplete="off"
            />
            <span className="field-hint">Endereço da sua instância Evolution.</span>
          </label>

          {/* Instância */}
          <label className="field">
            <span>Instância</span>
            <input
              type="text"
              value={cfg.instance}
              onChange={update('instance')}
              placeholder="minha-instancia"
              autoComplete="off"
            />
            <span className="field-hint">Nome da instância configurada na Evolution.</span>
          </label>

          {/* API Key */}
          <label className="field">
            <span>API Key</span>
            <span className="field-input-wrap">
              <input
                type={showKey ? 'text' : 'password'}
                value={cfg.apiKey}
                onChange={update('apiKey')}
                placeholder="••••••••••••"
                autoComplete="off"
              />
              <button
                type="button"
                className="field-reveal"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Ocultar API Key' : 'Mostrar API Key'}
              >
                {showKey ? 'Ocultar' : 'Mostrar'}
              </button>
            </span>
            <span className="field-hint">Chave de autenticação da Evolution API.</span>
          </label>

          {/* Destino */}
          <div className="field">
            <span>Destino</span>

            {/* Linha: dropdown de grupos + botão buscar */}
            <div className="groups-row">
              <select
                className="select groups-select"
                value={
                  groups.some((g) => g.id === cfg.target) ? cfg.target : ''
                }
                onChange={onSelectGroup}
                disabled={fetchingGroups || groups.length === 0}
              >
                <option value="">
                  {groups.length === 0
                    ? '— busque os grupos da Evolution —'
                    : '— selecione um grupo —'}
                </option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name || g.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn ghost"
                onClick={onFetchGroups}
                disabled={fetchingGroups || saving || testing}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                {fetchingGroups && <span className="spinner small" />}
                {fetchingGroups ? 'Buscando…' : 'Buscar grupos'}
              </button>
            </div>

            {groupsError && (
              <div className="alert warn" style={{ marginTop: 2 }}>
                {groupsError}
              </div>
            )}

            {/* Alternativa manual */}
            <button
              type="button"
              className="link-toggle"
              onClick={() => setManualTarget((v) => !v)}
            >
              {manualTarget ? 'esconder entrada manual' : 'ou inserir manualmente'}
            </button>

            {manualTarget && (
              <input
                type="text"
                value={cfg.target}
                onChange={update('target')}
                placeholder="número (5511...) ou ID do grupo (...@g.us)"
                autoComplete="off"
              />
            )}

            <span className="field-hint">
              Escolha um grupo no dropdown (clique em <strong>Buscar grupos</strong>) ou
              insira manualmente um número (ex: <code>5511999999999</code>) ou o ID de um
              grupo (ex: <code>1203...@g.us</code>).
              {cfg.target && (
                <>
                  {' '}Destino atual: <code>{cfg.target}</code>.
                </>
              )}
            </span>
          </div>

          {/* Nome do destino */}
          <label className="field">
            <span>Nome do destino</span>
            <input
              type="text"
              value={cfg.targetName}
              onChange={update('targetName')}
              placeholder="Grupo Suporte"
              autoComplete="off"
            />
            <span className="field-hint">Rótulo amigável para identificar o destino.</span>
          </label>

          {/* Resultado do teste */}
          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              <Icon name={testResult.ok ? 'check' : 'x'} size={18} />
              <span>{testResult.message}</span>
            </div>
          )}

          {/* Ações */}
          <div className="form-actions" style={{ gap: 10 }}>
            <button
              type="button"
              className="btn ghost"
              onClick={onTest}
              disabled={testing || saving}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              {testing && <span className="spinner small" />}
              {testing ? 'Enviando…' : 'Testar envio'}
            </button>
            <button className="btn primary" disabled={saving || testing}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </section>

      {/* === IA · Google Gemini =========================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="activity" size={18} /> Análise Inteligente (Google Gemini)
        </h2>
        <div className="alert info" style={{ marginBottom: 4 }}>
          Com a IA ativada, o <strong>Modo Guardião</strong> analisa cada detecção e
          identifica se é pessoa, veículo ou animal — reduzindo alarmes falsos e
          descrevendo o que foi visto.
        </div>
      </section>

      <section className="panel">
        <form className="camera-form" onSubmit={onSaveGemini}>
          {/* Ativar IA */}
          <div className="switch-row">
            <span className="switch-text">
              <strong>Ativar IA</strong>
              <span className="field-hint">
                Quando desligada, as detecções não são analisadas pela IA.
              </span>
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={!!gem.enabled}
                onChange={updateGem('enabled')}
              />
              <span className="slider" />
            </label>
          </div>

          {/* API Key */}
          <label className="field">
            <span>API Key</span>
            <span className="field-input-wrap">
              <input
                type={gemShowKey ? 'text' : 'password'}
                value={gem.apiKey}
                onChange={updateGem('apiKey')}
                placeholder={
                  gem.configured
                    ? gem.apiKeyMasked || '•••• chave configurada ••••'
                    : 'AIza...'
                }
                autoComplete="off"
              />
              <button
                type="button"
                className="field-reveal"
                onClick={() => setGemShowKey((v) => !v)}
                aria-label={gemShowKey ? 'Ocultar API Key' : 'Mostrar API Key'}
              >
                {gemShowKey ? 'Ocultar' : 'Mostrar'}
              </button>
            </span>
            <span className="field-hint">
              {gem.configured
                ? 'Deixe em branco para manter a chave atual. '
                : ''}
              Crie sua chave grátis em{' '}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}
              >
                aistudio.google.com/apikey
              </a>
              .
            </span>
          </label>

          {/* Modelo */}
          <label className="field">
            <span>Modelo</span>
            <input
              type="text"
              value={gem.model}
              onChange={updateGem('model')}
              placeholder="gemini-2.0-flash"
              autoComplete="off"
            />
            <span className="field-hint">
              Padrão: <code>gemini-2.0-flash</code> (rápido e econômico).
            </span>
          </label>

          {/* Modo */}
          <label className="field">
            <span>Modo</span>
            <select
              className="select"
              value={gem.mode}
              onChange={updateGem('mode')}
            >
              <option value="pessoas">Só pessoas e veículos (recomendado)</option>
              <option value="tudo">Avisar de tudo (descreve tudo)</option>
            </select>
            <span className="field-hint">
              Define o que a IA considera relevante ao analisar uma detecção.
            </span>
          </label>

          {/* Resultado do teste */}
          {gemTestResult && (
            <div className={`test-result ${gemTestResult.ok ? 'ok' : 'fail'}`}>
              <Icon name={gemTestResult.ok ? 'check' : 'x'} size={18} />
              <span>
                {gemTestResult.ok
                  ? `✅ Funcionou! Detectado: ${gemTestResult.label || '—'}${
                      gemTestResult.description
                        ? ` — ${gemTestResult.description}`
                        : ''
                    }`
                  : `Falha: ${gemTestResult.message}`}
              </span>
            </div>
          )}

          {/* Ações */}
          <div className="form-actions" style={{ gap: 10 }}>
            <button
              type="button"
              className="btn ghost"
              onClick={onTestGemini}
              disabled={gemTesting || gemSaving}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              {gemTesting && <span className="spinner small" />}
              {gemTesting ? 'Testando…' : 'Testar conexão'}
            </button>
            <button className="btn primary" disabled={gemSaving || gemTesting}>
              {gemSaving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </section>

      {/* === Relatório automático ========================================= */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="activity" size={18} /> Relatório Inteligente
        </h2>
        <div className="alert info" style={{ marginBottom: 4 }}>
          Receba um resumo automático das detecções no seu WhatsApp. A IA (se
          ativada) redige o texto; senão, um resumo padrão é enviado.
        </div>
      </section>

      <section className="panel">
        <form className="camera-form" onSubmit={onSaveReport}>
          {/* Ativar relatório */}
          <div className="switch-row">
            <span className="switch-text">
              <strong>Ativar relatório</strong>
              <span className="field-hint">
                Quando desligado, nenhum resumo automático é enviado.
              </span>
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={!!rep.enabled}
                onChange={updateRep('enabled')}
              />
              <span className="slider" />
            </label>
          </div>

          {/* Frequência */}
          <label className="field">
            <span>Frequência</span>
            <select
              className="select"
              value={rep.frequency}
              onChange={updateRep('frequency')}
            >
              <option value="daily">Diário</option>
              <option value="weekly">Semanal (toda segunda)</option>
            </select>
            <span className="field-hint">
              Define a periodicidade do envio do resumo.
            </span>
          </label>

          {/* Horário */}
          <label className="field">
            <span>Horário</span>
            <input
              type="time"
              value={rep.time}
              onChange={updateRep('time')}
            />
            <span className="field-hint">
              Hora do envio (formato 24h). Padrão: <code>08:00</code>.
            </span>
          </label>

          {/* Destino — reaproveita os grupos buscados na seção do WhatsApp */}
          <div className="field">
            <span>Destino</span>
            {groups.length > 0 ? (
              <select
                className="select"
                value={groups.some((g) => g.id === rep.target) ? rep.target : ''}
                onChange={onSelectReportGroup}
              >
                <option value="">— usar o destino padrão do WhatsApp —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name || g.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={rep.target}
                onChange={updateRep('target')}
                placeholder="número (5511...) ou ID do grupo (...@g.us)"
                autoComplete="off"
              />
            )}
            <span className="field-hint">
              Opcional. Deixe em branco para usar o{' '}
              <strong>destino padrão do WhatsApp</strong>. Você pode buscar os
              grupos na seção do WhatsApp acima para selecioná-los aqui.
            </span>
          </div>

          {/* Usar IA para redigir */}
          <div className="switch-row">
            <span className="switch-text">
              <strong>Usar IA para redigir (Gemini)</strong>
              <span className="field-hint">
                Quando ativado, a IA escreve o texto do resumo; senão, é enviado
                um resumo padrão.
              </span>
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={!!rep.useAI}
                onChange={updateRep('useAI')}
              />
              <span className="slider" />
            </label>
          </div>

          {/* Último envio */}
          {rep.last_sent && (
            <span className="field-hint">
              Último envio: <code>{formatLastSent(rep.last_sent)}</code>.
            </span>
          )}

          {/* Resultado do teste — mostra o texto gerado (preview) e o status */}
          {repTestResult && (
            <div
              className={`test-result report-preview ${
                repTestResult.ok && repTestResult.sent ? 'ok' : 'fail'
              }`}
            >
              <div className="report-preview-head">
                <Icon
                  name={repTestResult.ok && repTestResult.sent ? 'check' : 'x'}
                  size={18}
                />
                <span>
                  {repTestResult.ok
                    ? repTestResult.sent
                      ? 'Relatório de teste enviado no WhatsApp!'
                      : 'Relatório gerado, mas não enviado.'
                    : `Falha: ${repTestResult.message}`}
                </span>
              </div>
              {repTestResult.preview && (
                <pre className="report-preview-text">{repTestResult.preview}</pre>
              )}
            </div>
          )}

          {/* Ações */}
          <div className="form-actions" style={{ gap: 10 }}>
            <button
              type="button"
              className="btn ghost"
              onClick={onTestReport}
              disabled={repTesting || repSaving}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              {repTesting && <span className="spinner small" />}
              {repTesting ? 'Enviando…' : 'Enviar teste agora'}
            </button>
            <button className="btn primary" disabled={repSaving || repTesting}>
              {repSaving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </section>

      {/* === Como pegar os dados ========================================== */}
      <section className="panel">
        <h2 className="panel-title">
          <Icon name="settings" size={18} /> Como pegar esses dados
        </h2>
        <div className="info-box">
          <ul>
            <li>
              <strong>Instância</strong> e <strong>API Key</strong> vêm do painel da sua
              Evolution API (na criação/conexão da instância).
            </li>
            <li>
              O <strong>ID do grupo</strong> (<code>...@g.us</code>) é obtido na Evolution,
              pelo endpoint de grupos (ex: <code>/group/fetchAllGroups</code>). Para enviar
              a um número, use o formato internacional sem símbolos (ex:{' '}
              <code>5511999999999</code>).
            </li>
            <li>
              A <strong>URL da Evolution</strong> é o endereço onde sua instância está
              rodando, incluindo a porta (ex: <code>http://127.0.0.1:8080</code>).
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
