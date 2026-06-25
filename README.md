# 🎥 VizionPro — Sistema

> Plataforma profissional de monitoramento de câmeras IP, feita para provedores de internet (ISP) oferecerem videomonitoramento aos seus clientes. Este repositório contém o **backend (API)**, o **painel administrativo web** e a **landing page**.

📱 **App mobile (iOS):** [`vizionprocam-app`](https://github.com/STARCOREDC/vizionprocam-app) &nbsp;•&nbsp; 🌐 **Site:** [vizionprocam.com](https://vizionprocam.com)

---

## 📐 Arquitetura

```
   ┌──────────────┐      ┌──────────────┐
   │  App iOS      │      │  Painel Web   │
   │  (Expo/RN)    │      │  (React)      │
   └──────┬───────┘      └──────┬───────┘
          │        HTTPS        │
          └──────────┬──────────┘
                     ▼
          ┌─────────────────────┐
          │   nginx (proxy/SSL)  │   Let's Encrypt
          └──────────┬──────────┘
            ┌─────────┴──────────┐
            ▼                    ▼
   ┌─────────────────┐   ┌──────────────────┐
   │ backend Fastify │   │     mediamtx      │
   │   (API :4000)   │   │ RTSP · HLS · REC  │
   └────────┬────────┘   └────────┬─────────┘
            ▼                     │ ffmpeg
   ┌─────────────────┐            ▼
   │   PostgreSQL    │   ┌──────────────────┐
   └─────────────────┘   │  Câmeras IP      │
                         │ (RTSP via CGNAT) │
                         └──────────────────┘
```

O app/painel falam **só com o backend** (HTTPS). O backend orquestra o **mediamtx** (streaming/gravação) e o **PostgreSQL** (dados). As câmeras são acessadas por **RTSP/ONVIF**, funcionando inclusive atrás de **CGNAT** (via port-forward/DMZ no roteador do cliente).

---

## 📂 Estrutura do repositório

| Pasta | Descrição |
|-------|-----------|
| **`backend/`** | API REST em Node.js + Fastify |
| **`frontend/`** | Painel administrativo web (React + Vite) |
| **`landing/`** | Site institucional / de vendas (estático) |

---

## ⚙️ Backend (`backend/`)

API em **Node.js + Fastify**. Módulos principais em `src/`:

| Arquivo | Responsabilidade |
|---------|------------------|
| `routes/auth.js` | Login + JWT (sessão de 30 dias) |
| `routes/cameras.js` | CRUD de câmeras + **PTZ** (mover/preset via ONVIF) |
| `routes/playback.js` | Reprodução de gravações com HTTP Range (player DVR) |
| `routes/push.js` | Registro de tokens de notificação (Expo) |
| `routes/{alerts,events,groups,presets,faces,integrations,report}.js` | Recursos do painel |
| `mediamtx.js` | Integração com o mediamtx + **auto-resync** dos paths |
| `guardian.js` | **Guardião IA** — detecta movimento e classifica a cena (Gemini) |
| `health.js` | Monitor de saúde (online/offline) + alerta recorrente de queda |
| `ptz.js` | Controle PTZ — mover, salvar/ir ao preset, **auto-retorno ao reconectar** |
| `push.js` | Envio de notificações (Expo Push API) |

**Stack:** Fastify · PostgreSQL · mediamtx · FFmpeg · ONVIF · Expo Push · Google Gemini (visão computacional)

### Como rodar
```bash
cd backend
npm install
# configure as variáveis de ambiente (.env / .dbenv) — veja abaixo
npm start                 # node src/server.js  (porta 4000)
npm run create-admin      # cria o primeiro usuário admin
```

Em produção roda como serviço `systemd` (`vizionpro-api`).

---

## 🖥️ Painel administrativo (`frontend/`)

SPA em **React + Vite** (`hls.js` para o ao vivo). Gerencia câmeras, usuários, grupos, alertas, relatórios, mosaico e integrações.

```bash
cd frontend
npm install
npm run dev      # desenvolvimento (Vite)
npm run build    # build de produção -> dist/
```

---

## 🌐 Landing (`landing/`)

Site estático (HTML/CSS/JS) servido em `vizionprocam.com` — apresentação do produto + política de privacidade.

---

## ✨ Funcionalidades

- 🎥 **Ao vivo** (HLS de baixa latência) + 🎬 **gravação 24/7** (DVR com retenção configurável por câmera)
- 🕹️ **PTZ** — controle de movimento, presets e **retorno automático** ao ângulo salvo quando a câmera reinicia
- 🛡️ **Guardião IA** — detecção inteligente de movimento (pessoa / veículo / objeto) com classificação por IA
- 🔔 **Notificações push** — movimento e câmera offline (com lembrete recorrente)
- 📊 Multi-câmera, grupos de usuários, relatórios e mosaico
- 🌐 Funciona sob **CGNAT** (RTSP/ONVIF via port-forward ou DMZ)
- 🔄 **Auto-resync** — se o mediamtx reiniciar, o backend recria os streams sozinho

---

## 🔒 Segurança

> ⚠️ **Segredos nunca são versionados.** As credenciais (banco, chaves de API, etc.) ficam em `.env` / `.dbenv`, que estão no `.gitignore`. Nunca faça commit desses arquivos.

---

<sub>© 2026 Starcore Data Center — VizionPro</sub>
