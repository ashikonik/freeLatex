# freeLatex

> A portable, self-hostable collaborative LaTeX workspace combining the power of **Overleaf** with the modern AI capabilities of **LetX**.

---

## ✨ Features

- **Dual-Mode Backend**:
  - **Single-Host Mode**: One master `ADMIN_API_KEY` provides a private, zero-config workspace for an individual researcher or student.
  - **Multi-Tenant Mode**: Provision personal **User API Keys** (`sk_user_...`) for team or lab environments with isolated document workspaces.
- **Instant Collaboration**: Generate link-based share tokens (`/p/{id}?token=rw_...`). Anyone with the link can edit or view in real time—no registration or login required.
- **Multiplayer CRDT Editor**: Low-latency collaborative editing powered by **CodeMirror 6** and **Yjs** with color-coded cursors, presence tags, and conflict-free merging.
- **Hybrid Compilation Engine**:
  - **Client-Side WebAssembly**: Instant in-browser compilation with zero server latency.
  - **Server-Side Tectonic**: Full CTAN package support, BibTeX citations, and high-performance compilation under a lightweight footprint (<300MB Docker image).
- **Bidirectional SyncTeX**: Jump from LaTeX code directly to the corresponding PDF element, or double-click the PDF to jump back to the exact source line.
- **LetX AI Assistant (BYOK)**:
  - Bring your own API key (Gemini, OpenAI, Anthropic).
  - **One-click compilation error fixing** with visual diff preview.
  - In-editor copilot for equation generation and academic tone polishing.

---

## 📂 Project Structure & Documentation

Detailed project architecture and implementation phases are documented in:
- 📑 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — Comprehensive technical roadmap and phase deliverables.
- 📐 [ARCHITECTURE.md](ARCHITECTURE.md) — Deep dive into the Dual-Mode auth, Yjs sync protocol, compiler engines, and SyncTeX design.

```
freeLatex/
├── client/                     # Vite + React + CodeMirror 6 + PDF.js
├── server/                     # Fastify + TypeScript + Yjs WebSocket + Tectonic
├── docker/                     # Lightweight Dockerfile (<300MB) & docker-compose
├── data/                       # SQLite DB (freelatex.db) and project files
├── ARCHITECTURE.md             # System design and protocol specification
├── IMPLEMENTATION_PLAN.md      # Step-by-step implementation roadmap
└── README.md                   # Project overview & quickstart
```

---

## 🚀 Quickstart

### 1. Single-User Mode (Default)
Run a private instance on your machine or VPS:
```bash
export ADMIN_API_KEY="your-secret-admin-key"
export AUTH_MODE="single"
npm run dev
```

### 2. Multi-User Mode
Run a shared server where multiple users have distinct API keys:
```bash
export ADMIN_API_KEY="your-secret-admin-key"
export AUTH_MODE="multi"
npm run dev
```

### 3. Docker Deployment
The image holds the server, the client's built files and the Tectonic
compiler, so a deployment is one container on one port.

```bash
docker build -f docker/Dockerfile -t freelatex .
docker run -p 3030:3030 -e ADMIN_API_KEY="my-secret" -v freelatex_data:/app/data freelatex
```

Or with compose:
```bash
cd docker
ADMIN_API_KEY="my-secret" docker compose up --build
```

The container serves the whole application on <http://localhost:3030>.

To build a smaller image without the in-browser preview:
```bash
docker build -f docker/Dockerfile --build-arg WITH_WASM=false -t freelatex .
```
That image skips the BusyTeX WebAssembly assets (520 MB) and offers the
**🖥️ Server Tectonic Build** mode only.

### 4. Frontend
```bash
cd client
npm install
npm run download-assets   # fetches the BusyTeX WebAssembly engine (~520 MB, once)
npm run dev               # http://127.0.0.1:5173
```

The `download-assets` step is required only for the **⚡ Instant Wasm Preview**
mode. The assets are not committed to the repository; they are fetched from
the [texlyre-busytex](https://github.com/TeXlyre/texlyre-busytex) release
archive and served from `client/public/core/busytex`. Without them the
**🖥️ Server Tectonic Build** mode still works, because it compiles on the
server.

The Docker build fetches these assets itself, so a container ships with the
instant preview ready to use.

---

## 📜 License
MIT License. Built for open, portable, and unrestricted scientific publishing.
