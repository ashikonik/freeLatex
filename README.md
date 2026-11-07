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
  - **Server-Side Tectonic**: Full CTAN package support, BibTeX citations, and high-performance compilation from a single container (see [Docker](#3-docker-deployment) for the image sizes).
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
- 🚀 [docker/DEPLOY.md](docker/DEPLOY.md) — Putting it on a free cloud service, with the free tiers that can and cannot host it.

```
freeLatex/
├── client/                     # Vite + React + CodeMirror 6 + PDF.js
├── server/                     # Fastify + TypeScript + Yjs WebSocket + Tectonic
├── docker/                     # Multi-stage Dockerfile, docker-compose & deployment guide
├── ARCHITECTURE.md             # System design and protocol specification
├── IMPLEMENTATION_PLAN.md      # Step-by-step implementation roadmap
└── README.md                   # Project overview & quickstart
```

---

## 🚀 Quickstart

### 1. Single-User Mode (Default)
Run a private instance on your machine or VPS. The server and the client are
two packages, so each is started from its own directory:
```bash
cd server
export ADMIN_API_KEY="your-secret-admin-key"
export AUTH_MODE="single"
npm install && npm run dev
```

In a second terminal:
```bash
cd client
npm install && npm run dev
```

### 2. Multi-User Mode
Run a shared server where multiple users have distinct API keys:
```bash
cd server
export ADMIN_API_KEY="your-secret-admin-key"
export AUTH_MODE="multi"
npm install && npm run dev
```

The client is started the same way as above. The admin provisions a key for
each user with `POST /api/auth/keys`.

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
That image skips the BusyTeX WebAssembly assets (727 MB), weighs 566 MB
instead of 1.82 GB, and offers the **🖥️ Server Tectonic Build** mode only.

### 4. Frontend
```bash
cd client
npm install
npm run download-assets   # fetches the BusyTeX WebAssembly engine (~727 MB, once)
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

### 5. Inviting a co-editor
There are two ways to give somebody access, and they differ in what the
person needs from you.

**A share link** needs nothing from them. Open a project, press *Share*,
create a link with the permission you want, and send it over. The link is a
URL of the form `/p/{projectId}?token=rw_...`; opening it takes the reader
straight into the editor, with no account and no sign-in. A `rw_` link may
edit, an `ro_` link may only read. The link can be given an expiry date and
can be revoked at any time from the same panel. The plaintext token is shown
only once, when it is created.

**A user key** gives somebody a workspace of their own. In `AUTH_MODE=multi`
the admin provisions a key for them with `POST /api/auth/keys`; they sign in
with it and see only their own projects. Use this when a collaborator should
have their own projects rather than access to one of yours.

For a small group working on one document, the share link is the simpler
choice.

---

## ⚙️ Configuration

The server reads its configuration from the environment. Copy
`server/.env.example` to `server/.env` to set them for a development run; in
a container, pass them with `-e`.

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_API_KEY` | — | **Required.** The master credential. In `single` mode it is the only key; in `multi` mode it lets the admin provision user keys. |
| `AUTH_MODE` | `single` | `single` for a private instance, `multi` for one instance with isolated per-user workspaces. |
| `PORT` | `3030` | The port the HTTP and WebSocket listener binds. |
| `HOST` | `0.0.0.0` | The address the listener binds. |
| `DATA_DIR` | `data` | Where the SQLite database and the project files live. |
| `COMPILE_TIMEOUT_MS` | `30000` | How long a LaTeX compilation may run before it is killed. |
| `MAX_CONCURRENT_COMPILATIONS` | the core count, capped at 4 | How many compilations may run at once. Each one is a whole TeX engine and wants about 190 MB, so a small host should set this to 1. |
| `STATIC_DIR` | — | The client's built files. Set it to serve the client from the server, so the whole application is one origin. |
| `CORS_ORIGIN` | — | The one origin allowed to call the API from a browser. Leave it unset unless the client is served from somewhere else. |
| `NODE_ENV` | `development` | The usual environment name. |

**Cross-origin access is off by default.** A deployment that serves the client
itself needs none: the browser talks to one origin. Set `CORS_ORIGIN` only
when the client is served from a different origin — for example the Vite dev
server — and name the single origin that is allowed.

### 🔑 What the credentials can do

- **`ADMIN_API_KEY`** reaches everything, including the admin routes that
  provision and revoke user keys.
- **A user key** (`sk_user_...`) reaches only its own projects.
- **A share token** (`ro_...` or `rw_...`) reaches exactly one project.
  A read-only token may read the files but may not change anything, may not
  compile, and may not spend the owner's AI key. A read-only token is
  refused at the collaboration socket as well.

---

## 📜 License
[MIT License](LICENSE). Built for open, portable, and unrestricted scientific publishing.
