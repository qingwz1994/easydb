<p align="center">
  <img src="apps/desktop-ui/src-tauri/icons/icon.png" width="128" height="128" alt="EasyDB Logo">
</p>

<h1 align="center">EasyDB</h1>

<p align="center">
  <strong>Open-source, cross-platform database management tool</strong><br>
  Connection Management · Object Browser · SQL Editor · Data Migration · Data Sync · Data Export · Task Center · Storage Management
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/database-MySQL-4479A1?logo=mysql&logoColor=white" alt="MySQL">
  <img src="https://img.shields.io/badge/version-1.3.0-green" alt="Version">
</p>

<p align="center">
  <a href="README.zh-CN.md">🇨🇳 中文文档</a>
</p>

---

## ✨ Features

### 🔌 Connection Management
- Create, edit, test, group, and search MySQL connections
- SSH tunnel support

### 🗂️ Database Workbench
- Object tree browser (Database → Table → Columns / Indexes)
- Data preview with WHERE filter, column sorting, and field auto-completion
- Table structure and DDL viewer

### ✏️ SQL Editor
- Powered by Monaco Editor with syntax highlighting
- **Smart auto-completion**: table names, column names, SQL keywords, MySQL functions
- Context-aware: auto-detects tables in FROM/JOIN clauses and suggests columns
- Execute selected text or full script with `⌘+Enter`

### 🚀 Data Migration
- Wizard-style workflow: Select Connection → Select Objects → Configure Strategy → Execute
- Supports both schema migration and data migration

### 🔄 Data Sync
- Table-level real-time sync with INSERT / UPSERT strategies
- **Performance optimized**: 1.9M rows sync reduced from 48 min → 5 min 25 sec (9x faster)
  - `rewriteBatchedStatements` for batch writes
  - Disables `unique_checks` / `foreign_key_checks` during sync
  - Dynamic batch size (5,000 for regular tables, 10,000 for large tables)

### 📤 Data Export
- Export entire database as a ZIP archive (with CREATE TABLE SQL + INSERT data)
- Supports export cancellation with automatic cleanup of incomplete files
- Download exported files directly

### 📥 SQL File Import
- Upload and execute `.sql` files
- Import progress tracking and mid-process cancellation

### 📋 Task Center
- Unified management for migration, sync, export, and import tasks
- Real-time progress, elapsed time, and log viewer
- Task cancellation, filtering, and history

### ⚙️ Settings
- Dark / Light / System theme switching
- Storage management: disk usage visualization, categorized cleanup (exports / logs / task records)
- Auto-update check

## 🛠️ Tech Stack

```
┌─────────────────────────────────────────────────┐
│            Desktop UI (React + TypeScript)       │
│        Ant Design · Monaco Editor · Zustand      │
├──────────────────── HTTP API ────────────────────┤
│              Kernel (Kotlin / JVM 21)            │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ Launcher │  │   Common   │  │   Drivers    │ │
│  │  (Ktor)  │  │ Interfaces │  │ MySQL (SPI)  │ │
│  └──────────┘  └────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────┘
         │                           │
    ┌────┴────┐                ┌─────┴─────┐
    │~/.easydb│                │  MySQL DB  │
    │ Local   │                │           │
    └─────────┘                └───────────┘
```

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 · TypeScript · Ant Design 6 · Monaco Editor · Zustand · Vite |
| Backend | Kotlin · Ktor · kotlinx.serialization · JVM 21 |
| Desktop | Tauri 2 (Rust) |
| Build | Gradle (Kotlin DSL) · npm workspace |

## 🚀 Getting Started

### Prerequisites

- JDK 21+
- Node.js 18+
- Rust (latest stable, required by Tauri)

### Installation

```bash
# Clone the repository
git clone https://github.com/qingwz1994/easydb.git
cd easydb

# Install frontend dependencies
npm install

# Start development environment (kernel + frontend)
./dev.sh start
```

Open http://localhost:5173 after startup.

### Common Commands

| Command | Description |
|---------|-------------|
| `./dev.sh start` | Start kernel + frontend |
| `./dev.sh stop` | Stop all services |
| `./dev.sh restart` | Restart all services |
| `./dev.sh rebuild` | Build + restart (use after modifying Kotlin code) |
| `./dev.sh status` | Check running status |
| `./dev.sh logs` | View kernel logs |

### Production Build

```bash
# Build desktop app (generates .app / .dmg / .exe)
cd apps/desktop-ui && npx tauri build
```

## 📁 Project Structure

```
easydb/
├── apps/desktop-ui/         # Frontend (React + Tauri)
│   ├── src/
│   │   ├── components/      # Shared components
│   │   ├── pages/           # Page modules
│   │   ├── services/        # API layer
│   │   ├── stores/          # Zustand state management
│   │   └── utils/           # Utilities
│   └── src-tauri/           # Tauri config & native layer
├── kernel/                  # Backend kernel (Kotlin multi-module)
│   ├── common/              # Interfaces + core services
│   ├── drivers/mysql/       # MySQL driver (connection/metadata/migration/sync)
│   ├── launcher/            # HTTP server entry (Ktor)
│   ├── tunnel/              # SSH tunnel
│   └── api/                 # Protocol definitions
├── scripts/                 # Build scripts
└── docs/                    # Documentation
```

## 🗺️ Roadmap

| Version | Status | Goals |
|---------|--------|-------|
| v1.0 | ✅ Released | MySQL connection → Workbench → SQL Editor → Migration → Sync → Task Center |
| v1.1.0 | ✅ Released | Connection search/filter, data export, task log improvements |
| v1.2.0 | ✅ Released | Data preview filter/sort/pagination, inline editing, schema diff, multi-tab |
| **v1.3.0** | 🚧 In Progress | Dark mode, SQL file import, storage management, query favorites, keyboard shortcuts, export cancellation, auto-update |
| v1.4.0 | 📋 Planned | View/procedure/function browser, database backup & restore |
| v1.5.0 | 📋 Planned | Slow query analysis, i18n, performance monitoring |

## 🤝 Contributing

Issues and Pull Requests are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) first.

## 📄 License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

- ✅ Free for personal use, study, and modification
- ✅ Commercial use allowed, but derivative works must be open-sourced under the same license
- ✅ SaaS deployment requires open-sourcing modified code

```
Copyright (c) 2024-2026 EasyDB Contributors
```
