# freeLatex System Architecture & Design Specification

This document details the architectural principles, protocols, data flows, security models, and verification systems of **freeLatex**—a 100% free-tier, portable, self-hostable collaborative LaTeX workspace with Overleaf and LetX capabilities.

---

## 1. Core Architecture Diagram

```mermaid
flowchart TB
    subgraph Browser ["Client Browser (React 19 + CodeMirror 6 + PDF.js)"]
        UI["Editor & Workspace UI"]
        CM["CodeMirror 6 LaTeX Editor"]
        YDoc["Yjs CRDT Document"]
        PDFV["PDF.js Viewer + SyncTeX Overlay"]
        WasmCompiler["Client-Side Wasm Compiler (Worker)"]
        AIService["AI Assistant (BYOK Client: Gemini Free Tier / OpenAI / Claude)"]
        HistoryUI["Version Control & Diff Viewer"]

        UI --- CM
        CM <--> YDoc
        UI --- PDFV
        UI --- AIService
        UI --- HistoryUI
        UI -->|Fast preview| WasmCompiler
        WasmCompiler -->|Render PDF Blob| PDFV
    end

    subgraph Server ["freeLatex Server (Node.js / Fastify :3030)"]
        Gateway["HTTP & WebSocket Gateway"]
        AuthMid["Dual-Mode Auth & Token Validator"]
        YServer["Yjs WebSocket Room Provider"]
        TectonicRunner["Server Tectonic LaTeX Runner"]
        SyncTeXEngine["SyncTeX Parser (synctex-js)"]
        SnapshotEngine["Version Control & Diff Service"]
        ProjectFS["Disk Storage (data/projects/&lt;id&gt;/)"]
        SQLite[(SQLite DB: freelatex.db)]

        Gateway --> AuthMid
        AuthMid --> YServer
        AuthMid --> TectonicRunner
        AuthMid --> SnapshotEngine
        AuthMid --> ProjectFS
        AuthMid --> SQLite

        YServer <--> ProjectFS
        SnapshotEngine <--> ProjectFS
        SnapshotEngine <--> SQLite
        TectonicRunner --> SyncTeXEngine
        TectonicRunner --> ProjectFS
    end

    subgraph External ["Free-Tier AI Provider (Optional BYOK)"]
        LLM["Google Gemini Free Tier (via AI Studio) / Local Ollama"]
    end

    YDoc <-->|Multiplayer Binary WS| Gateway
    CM -->|SyncTeX Forward Jump| PDFV
    PDFV -->|SyncTeX Inverse Jump| CM
    UI -->|Compile (Server Mode)| Gateway
    Gateway -->|PDF Stream + SyncTeX Data| PDFV
    AIService -->|Free API Key (localStorage)| LLM
```

---

## 2. 100% Free-Tier Architecture Breakdown

freeLatex is engineered to run at **zero recurring software or API cost**:

| Component | Free-Tier Technology | Cost | Description |
|---|---|---|---|
| **LaTeX Engine (Server)** | **Tectonic** | **$0** | Open-source compiler that auto-downloads only the CTAN packages actually imported by the document. |
| **LaTeX Engine (Client)** | **SwiftLaTeX WebAssembly** | **$0** | Compiles in the user's browser thread; zero server CPU and works offline. |
| **AI Assistant** | **Google Gemini Free Tier (BYOK)** | **$0** | 15 RPM / 1 million TPM free via Google AI Studio API key. Users input their own key; server incurs $0 cost. |
| **Real-time Sync** | **Yjs + Fastify WebSockets** | **$0** | Self-hosted CRDT synchronization. No paid services (e.g. Liveblocks/Pusher). |
| **Database** | **SQLite (`better-sqlite3`)** | **$0** | Single file on disk (`freelatex.db`). No hosted DB fees. |
| **Storage** | **Local Filesystem** | **$0** | Source files stored as plain text under `data/projects/{id}/`. |

---

## 3. In-Product Version Control & Diff Architecture

freeLatex provides full document revision history inspired by Overleaf:

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Collaborator
    participant Client as CodeMirror 6 / UI
    participant Server as Fastify Backend
    participant DB as SQLite (project_snapshots)
    participant Disk as data/projects/{id}/

    Note over User,Disk: Snapshot Creation (Automatic or Manual)
    User->>Server: POST /api/projects/:id/snapshots (label: "v1.0 Submission")
    Server->>Disk: Scan and read all files in project directory
    Server->>DB: INSERT INTO project_snapshots (projectId, label, snapshotData, timestamp)
    Server-->>User: Return snapshot record

    Note over User,Disk: Diff Viewing
    User->>Server: GET /api/projects/:id/snapshots/:snapshotId/diff
    Server->>DB: Fetch snapshot files
    Server->>Disk: Read current files
    Server->>Server: Compute unified diff per file
    Server-->>User: Return JSON with diff patches

    Note over User,Disk: Rollback / Restore
    User->>Server: POST /api/projects/:id/snapshots/:snapshotId/rollback
    Server->>DB: Retrieve snapshot content
    Server->>Disk: Overwrite project directory with snapshot files
    Server->>Client: Broadcast Yjs transaction restoring editor text
    Client-->>User: Editor displays restored version immediately
```

---

## 4. Dual-Mode Authentication Engine

freeLatex supports two operational topologies governed by `AUTH_MODE`:

### Mode 2-A: Single-Host Personal Mode (`AUTH_MODE=single`)
- Master credential: `ADMIN_API_KEY`.
- The instance owner has full control over all documents.
- Ideal for personal self-hosting on a home server, VPS, or local machine.

### Mode 2-C: Multi-User Tenant Mode (`AUTH_MODE=multi`)
- Master admin provisions personal **User API Keys** (`sk_user_...`).
- Queries are strictly scoped by tenant (`owner_id = user.id`).
- Projects, files, and quotas are isolated between users.

---

## 5. Development Multi-Headed Verification & Rollback Protocol

Every micro-step during implementation is verified by **3 independent verification heads**:

```mermaid
flowchart LR
    Step["Execute Step N"] --> H1["Head 1: Vitest Unit & Integration Tests"]
    H1 -->|Pass| H2["Head 2: TypeScript Strict Compilation (tsc --noEmit)"]
    H2 -->|Pass| H3["Head 3: Runtime Functional Smoke Test"]
    H3 -->|Pass| Diff["Generate Unified Diff (.dev_logs/step_N.log)"]
    Diff --> Tag["Git Commit & Tag checkpoint-step-N"]
    H1 -->|Fail| RB["scripts/dev-rollback.sh N"]
    H2 -->|Fail| RB
    H3 -->|Fail| RB
```

- **Head 1 (Automated Test & Contract Verification)**: Executes unit and contract tests in `vitest`.
- **Head 2 (Static Analysis & Type Integrity)**: Runs `tsc --noEmit` and linter checks with zero warnings/errors.
- **Head 3 (Runtime Functional Probe)**: Boots the actual service, executes HTTP/WebSocket probes, and tests disk I/O.
- **Rollback Tool (`scripts/dev-rollback.sh`)**: If any head fails, reverts to `checkpoint-step-<N-1>` instantaneously.
