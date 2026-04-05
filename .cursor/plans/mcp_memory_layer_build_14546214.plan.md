---
name: MCP Memory Layer Build
overview: "Build the MCP Memory Layer as a standalone Python project at /Users/Shared/WorkShared/mcp-memory. Uses FastMCP v3 (standalone package, NOT mcp.server.fastmcp). SQLite+FTS5+WAL, Pydantic validation, 9 tools (7 core + ping + stats), Cursor+Claude Desktop wiring, repo-doc ingestion. v2: integrated 2 technical reviews."
todos:
  - id: p0-env
    content: "Phase 0: Install Python 3.12 + uv, create project, verify MCP SDK"
    status: completed
  - id: p1-schema
    content: "Phase 1: Create SQLite schema, migrations, database layer, tests"
    status: completed
  - id: p2-server
    content: "Phase 2: Build MCP server with 7 tools, entry point, verify starts"
    status: completed
  - id: p3-wire
    content: "Phase 3: Wire to Cursor + Claude Desktop, restart, verify tools appear"
    status: completed
  - id: p4-ingest
    content: "Phase 4: Build repo-doc ingestion, ingest clandestine-fulfillment docs"
    status: completed
  - id: p5-hygiene
    content: "Phase 5: Add backup + stats tools, final verification"
    status: completed
isProject: false
---

# MCP Memory Layer -- Cursor Build Plan (v2)

# Feature
Local-first MCP memory server for persistent engineering knowledge across AI tools.

# Goal
Build a working MCP server that Cursor and Claude Desktop can connect to, with SQLite+FTS5+WAL storage, Pydantic-validated 9-tool interface, and repo-doc ingestion from clandestine-fulfillment as the first project. Solve the core failure mode: AI tools read code but do not reliably remember decisions, context, or history.

# Context

**Current environment (verified 2026-04-04):**
- macOS, Homebrew at `/opt/homebrew`
- Python 3.9.6 (system only) -- need 3.10+ for FastMCP
- Node v25.8.1 + npx 11.11.0 (available for filesystem MCP if needed)
- SQLite 3.51.0 with FTS5 enabled (verified)
- VACUUM INTO supported (verified, requires autocommit mode)
- Cursor MCP config: `~/.cursor/mcp.json` exists (empty `mcpServers: {}`)
- Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json` exists (empty `mcpServers: {}`)
- No existing MCP servers installed
- No `uv` installed (will install via Homebrew)
- No Python 3.11/3.12 installed (will install via Homebrew)

**What needs to happen first:**
- Install Python 3.12 + `uv` via Homebrew
- Create standalone project at `/Users/Shared/WorkShared/mcp-memory`
- Install `fastmcp>=3.2,<4` (standalone PyPI package, NOT `mcp.server.fastmcp`)

# Requirements

**Functional:**
- 9 MCP tools: `ping`, `search_memory`, `add_memory`, `get_feature_history`, `get_decisions`, `get_deferred_items`, `supersede_memory`, `mark_memory_inactive`, `memory_stats`
- Full-text search via SQLite FTS5
- Memory types: decision, plan, deviation, deferred, outcome, assumption, rejected_alternative, root_cause, observation
- Memory lifecycle: active -> superseded/invalidated (with confidence scores)
- Relation graph: supersedes, implements, relates_to, caused_by, validates, defers, contradicts
- Repo-doc ingestion with heuristic extraction from markdown headings
- Dry-run mode for ingestion preview
- Atomic backup via VACUUM INTO

**Non-functional:**
- Local-first (no network dependencies, no cloud storage)
- MCP stdio transport (Cursor + Claude Desktop compatible)
- Single SQLite database at `~/.local/share/mcp-memory/memory.db`
- WAL mode for concurrent read safety
- Pydantic validation on all inputs
- Logs to stderr only (stdout reserved for MCP protocol)
- Sub-second search response time for <100K memories

# Constraints

**Technical:**
- FastMCP v3.2+ is a standalone package: `from fastmcp import FastMCP`, decorator `@mcp.tool` (verified)
- Python >=3.10 required by FastMCP (verified)
- aiosqlite does not support connection pools; use single connection + asyncio.Lock for write serialization
- VACUUM INTO requires `isolation_level=None` (autocommit) -- verified on SQLite 3.51.0
- Cursor MCP config uses `"command": "uv", "args": ["run", "--directory", "...", "python", "-m", "..."]` pattern (verified)

**Product:**
- Memory DB is global (one DB, filter by `project_id`) -- not per-project
- Heuristic-extracted memories default to `is_active=0, confidence="low"` (require manual activation)
- No auto-ingestion on startup (explicit tool call only)

**External:**
- No external APIs or services required (fully local)
- No Supabase dependency
- No Ollama/embeddings dependency (Phase 5 future)

# Affected Files

**New project (standalone):**
- `/Users/Shared/WorkShared/mcp-memory/` -- entire new directory
  - `pyproject.toml` -- project config + dependencies
  - `src/memory_server/server.py` -- main MCP server with 7 tools
  - `src/memory_server/db.py` -- SQLite+FTS5 database layer
  - `src/memory_server/schema.py` -- migration system
  - `src/memory_server/ingest.py` -- repo-doc ingestion (Phase 2)
  - `migrations/001_initial.sql` -- initial schema
  - `tests/test_db.py` -- database layer tests
  - `tests/test_server.py` -- MCP tool tests

**Modified (config only):**
- `~/.cursor/mcp.json` -- add memory server entry
- `~/Library/Application Support/Claude/claude_desktop_config.json` -- add memory server entry

# Proposed Implementation

## Phase 0: Environment Setup

**Step 0.1:** Install Python 3.12 and uv via Homebrew:
```bash
brew install python@3.12 uv
```

**Step 0.2:** Create project with uv (pinned versions):
```bash
mkdir -p /Users/Shared/WorkShared/mcp-memory
cd /Users/Shared/WorkShared/mcp-memory
uv init --python 3.12
uv add "fastmcp>=3.2,<4" aiosqlite pydantic
```

**CRITICAL (from research):** FastMCP is now a standalone package (`fastmcp` v3.2.0 on PyPI), NOT part of the `mcp` package. The correct import is:
```python
from fastmcp import FastMCP  # NOT from mcp.server.fastmcp
```
The decorator is `@mcp.tool` not `@server.tool()`. Pin the version to avoid breaking changes.

**Step 0.3:** Verify FastMCP + FTS5:
```bash
uv run python -c "from fastmcp import FastMCP; print('FastMCP OK')"
uv run python -c "
import sqlite3
opts = str(sqlite3.connect(':memory:').execute('pragma compile_options').fetchall())
assert 'ENABLE_FTS5' in opts, 'FTS5 not available!'
print('FTS5 OK')
"
```

**Test:** Both commands exit 0.

## Phase 1: Schema + Database Layer

**Step 1.1:** Create `migrations/001_initial.sql` with explicit schema:

```sql
-- Enable WAL mode for concurrent reads during writes
PRAGMA journal_mode=WAL;

CREATE TABLE memories (
    id TEXT PRIMARY KEY,                    -- UUIDv7 for chronological sorting
    artifact_id TEXT,                       -- external reference (e.g., PR number, commit)
    project_id TEXT NOT NULL,               -- e.g., "clandestine-fulfillment"
    feature_id TEXT,                        -- e.g., "bandcamp-sales-backfill"
    memory_type TEXT NOT NULL,              -- decision, plan, deviation, deferred, outcome, assumption, rejected_alternative, root_cause, observation
    title TEXT,
    content TEXT NOT NULL,
    summary TEXT,                           -- one-line for retrieval display
    revision INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',           -- active, superseded, invalidated
    confidence TEXT DEFAULT 'high',         -- high, medium, low
    priority TEXT,                          -- p0, p1, p2
    tags TEXT,                              -- JSON array of tags: ["billing","reliability","p0"]
    source_label TEXT,                      -- filename or origin
    provenance_json TEXT,                   -- {"source_tool":"cursor","reviewed_by":["claude"]}
    original_timestamp TEXT,                -- when the decision was actually made (vs when recorded)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    supersedes_memory_id TEXT,
    is_active INTEGER DEFAULT 1,
    content_hash TEXT                       -- SHA256 of content for re-ingestion detection
);

CREATE TABLE memory_links (
    id TEXT PRIMARY KEY,
    from_memory_id TEXT NOT NULL REFERENCES memories(id),
    to_memory_id TEXT NOT NULL REFERENCES memories(id),
    relation_type TEXT NOT NULL,            -- supersedes, implements, relates_to, caused_by, validates, defers, contradicts
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_memory_id, to_memory_id, relation_type)
);

-- Indexes for filtered queries
CREATE INDEX idx_memories_project ON memories(project_id);
CREATE INDEX idx_memories_feature ON memories(feature_id);
CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_active ON memories(is_active);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_links_from ON memory_links(from_memory_id);
CREATE INDEX idx_links_to ON memory_links(to_memory_id);

-- FTS5 (content-bearing, synced via triggers)
CREATE VIRTUAL TABLE memories_fts USING fts5(
    memory_id UNINDEXED,
    title,
    content,
    summary,
    project,
    feature
);

-- Triggers to keep FTS in sync
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(memory_id, title, content, summary, project, feature)
  VALUES (new.id, new.title, new.content, new.summary, new.project_id, new.feature_id);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts(memory_id, title, content, summary, project, feature)
  VALUES (new.id, new.title, new.content, new.summary, new.project_id, new.feature_id);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;

-- updated_at auto-trigger
CREATE TRIGGER memories_updated AFTER UPDATE ON memories BEGIN
  UPDATE memories SET updated_at = datetime('now') WHERE id = new.id;
END;

CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO schema_version(version) VALUES (1);
```

**Step 1.2:** Create Pydantic models in `src/memory_server/models.py`:

```python
from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum

class MemoryType(str, Enum):
    decision = "decision"
    plan = "plan"
    deviation = "deviation"
    deferred = "deferred"
    outcome = "outcome"
    assumption = "assumption"
    rejected_alternative = "rejected_alternative"
    root_cause = "root_cause"
    observation = "observation"

class MemoryStatus(str, Enum):
    active = "active"
    superseded = "superseded"
    invalidated = "invalidated"

class MemoryRecord(BaseModel):
    project_id: str
    memory_type: MemoryType
    content: str
    title: Optional[str] = None
    summary: Optional[str] = None
    feature_id: Optional[str] = None
    artifact_id: Optional[str] = None
    status: MemoryStatus = MemoryStatus.active
    confidence: str = "high"
    priority: Optional[str] = None
    tags: Optional[list[str]] = None
    source_label: Optional[str] = None
    provenance_json: Optional[dict] = None
    original_timestamp: Optional[str] = None
    supersedes_memory_id: Optional[str] = None

class MemoryLink(BaseModel):
    to_memory_id: str
    relation_type: str  # supersedes, implements, relates_to, caused_by, validates, defers, contradicts
```

**Step 1.3:** Create `src/memory_server/db.py`:
- `MemoryDB` class wrapping aiosqlite
- **WAL mode** enabled on connection for concurrent read safety
- **Single long-lived connection** with an `asyncio.Lock` for write serialization (aiosqlite doesn't support connection pools; WAL + single writer is the correct pattern)
- `async def initialize()` -- apply migrations, verify FTS5
- `async def add_memory(record: MemoryRecord, links: list[MemoryLink])` -- validate via Pydantic, insert + FTS + links in one transaction, generate UUIDv7 ID, compute content_hash (SHA256)
- `async def search(query, filters)` -- FTS5 MATCH with optional project/feature/type/status filters
- `async def get_feature_history(feature_id)` -- all memories for a feature, ordered by created_at
- `async def get_decisions(project_id)` -- type=decision, is_active=1
- `async def get_deferred_items(project_id)` -- type=deferred, is_active=1
- `async def supersede(old_id, new_id, reason)` -- mark old status=superseded + is_active=0, create supersedes link, **check for cycles** (query chain before committing)
- `async def mark_inactive(memory_id, reason)` -- set is_active=0
- Database path: `~/.local/share/mcp-memory/memory.db` (XDG-style, created automatically)

**Step 1.4:** Create `tests/test_db.py`:
- Test add + search round-trip
- Test FTS ranking
- Test supersede chain + cycle prevention
- Test feature history ordering
- Test link creation + foreign key enforcement
- Test Pydantic validation rejects bad input
- Test content_hash dedup detection
- Test concurrent reads during write (WAL)

**Test:** `uv run pytest tests/test_db.py` -- all pass.

## Phase 2: MCP Server + Tools

**CRITICAL (from research):** FastMCP v3 is a standalone package. Import is `from fastmcp import FastMCP`, decorator is `@mcp.tool`.

**Step 2.1:** Create `src/memory_server/server.py` with FastMCP v3:

```python
import logging
import sys
from fastmcp import FastMCP

# Logging to stderr only (stdout is MCP protocol)
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("memory")

mcp = FastMCP(name="memory")

@mcp.tool
async def ping() -> str:
    """Health check. Returns 'ok' if the memory server is running."""
    return "ok"

@mcp.tool
async def search_memory(query: str, project_id: str = None, feature_id: str = None, memory_type: str = None, active_only: bool = True) -> list[dict]:
    """Search engineering memory by text, with optional filters for project, feature, type."""

@mcp.tool
async def add_memory(record: dict, links: list[dict] = []) -> dict:
    """Add a structured memory (decision, plan, deviation, etc.) with optional links.
    Record must include: project_id, memory_type, content.
    Optional: title, summary, feature_id, confidence, tags, status."""

@mcp.tool
async def get_feature_history(feature_id: str) -> list[dict]:
    """Get the full chronological history of a feature: plans, decisions, deviations, outcomes."""

@mcp.tool
async def get_decisions(project_id: str) -> list[dict]:
    """Get all active decisions for a project."""

@mcp.tool
async def get_deferred_items(project_id: str) -> list[dict]:
    """Get all active deferred items for a project."""

@mcp.tool
async def supersede_memory(old_memory_id: str, new_memory_id: str, reason: str = None) -> dict:
    """Mark an old memory as superseded by a new one. Creates a 'supersedes' link."""

@mcp.tool
async def mark_memory_inactive(memory_id: str, reason: str = None) -> dict:
    """Mark a memory as inactive (soft delete). Does not delete data."""

@mcp.tool
async def memory_stats() -> dict:
    """Get counts by type, project, status, and active/inactive. Useful for debugging."""
```

9 tools total: 7 core + `ping` (health check) + `memory_stats` (debugging).

**Step 2.2:** Add `__main__.py` entry point:
```python
from memory_server.server import mcp
mcp.run()
```

**Step 2.3:** Test the server starts:
```bash
uv run python -m memory_server  # should start and listen on stdio
```

**Test:** Server starts without error, `Ctrl+C` exits cleanly. No output to stdout (protocol only).

## Phase 3: Wire to Cursor + Claude Desktop

**Step 3.1:** Update `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "memory": {
      "command": "uv",
      "args": ["--directory", "/Users/Shared/WorkShared/mcp-memory", "run", "python", "-m", "memory_server"],
      "env": {}
    }
  }
}
```

**Step 3.2:** Update Claude Desktop config:
```json
{
  "mcpServers": {
    "memory": {
      "command": "uv",
      "args": ["--directory", "/Users/Shared/WorkShared/mcp-memory", "run", "python", "-m", "memory_server"]
    }
  }
}
```

**Step 3.3:** Restart Cursor and Claude Desktop.

**Test:** In Cursor, type "search memory for decisions" -- the tool should appear in the MCP tool list. In Claude Desktop, verify the memory server appears in the server list.

## Phase 4: Repo-Doc Ingestion

**Step 4.1:** Create `src/memory_server/ingest.py`:
- `async def ingest_markdown_file(path, project_id, dry_run=False)` -- parse a markdown file into structured memories
- **Provenance hashing:** compute SHA256 of file content + store last-modified time. On re-ingestion, skip files whose hash hasn't changed.
- **Deterministic heading detection:**
  - `# Decisions` / `# Decision` -> `memory_type = "decision"`
  - `# Deferred` / `# Deferred items` -> `memory_type = "deferred"`
  - `# Deviations` / `# Deviations from plan` -> `memory_type = "deviation"`
  - `# Rejected alternatives` -> `memory_type = "rejected_alternative"`
  - `# Assumptions` -> `memory_type = "assumption"`
  - `# Risks` -> `memory_type = "observation"`
  - `# Proposed implementation` / `# Goal` / `# Feature` -> `memory_type = "plan"`
  - `# Final outcome` / `# Validation` -> `memory_type = "outcome"`
  - Unrecognized headings -> `memory_type = "observation"` with `confidence = "low"`
- **Section boundary rules:** content between headings of the same level constitutes one memory. Code blocks are preserved intact, not split.
- Each extracted section becomes a memory with:
  - `confidence` = "low" for heuristic extraction
  - `is_active` = 0 (requires manual activation)
  - `source_label` = filename
  - `content_hash` = SHA256 of the section content
  - `provenance_json` = `{"source_tool": "ingestion", "file_hash": "...", "file_mtime": "..."}`
- **Dry-run mode:** when `dry_run=True`, return what would be created without writing to DB.

**Step 4.2:** Add `ingest_repo_docs` MCP tool:
```python
@mcp.tool
async def ingest_repo_docs(repo_path: str, project_id: str, patterns: list[str] = ["plans/*.md", "docs/**/*.md"], dry_run: bool = False) -> dict:
    """Scan a repo for plan/decision docs and ingest them as memories.
    Use dry_run=True to preview what would be created without writing."""
```

Returns: `{ files_scanned, memories_created, memories_skipped (hash unchanged), dry_run_preview: [...] }`

**Step 4.3:** Ingest clandestine-fulfillment docs:
- Call `ingest_repo_docs("/Users/Shared/WorkShared/Project/clandestine-fulfillment", "clandestine-fulfillment", dry_run=True)` first to preview
- Then run without dry_run
- Targets: `TRUTH_LAYER.md`, all files in `.cursor/plans/`, `docs/system_map/`, `project_state/`, `docs/handoff/`

**Test:** After ingestion, `search_memory("bandcamp sales backfill")` returns relevant plan memories. `memory_stats()` shows correct counts by type.

## Phase 5: Backup + Hygiene

**Step 5.1:** Add backup tool (atomic, using VACUUM INTO):
```python
@mcp.tool
async def backup_memory(output_path: str = None) -> dict:
    """Create an atomic SQLite backup of the memory database using VACUUM INTO."""
```
Uses `VACUUM INTO` (not file copy) for atomic backup. Default path: `~/.local/share/mcp-memory/backups/memory-{date}.db`

**Step 5.2:** `memory_stats` already defined in Phase 2. Ensure it returns:
- Count by `memory_type`
- Count by `project_id`
- Count by `status` (active/superseded/invalidated)
- Count of `is_active` true vs false
- Count of supersede chains (memories with `supersedes_memory_id != null`)
- Count of orphaned links (links pointing to deleted memories)
- Total memories, total links

**Test:** Backup creates a valid SQLite file that can be opened independently. Stats returns correct counts matching direct SQL queries.

# Assumptions

- Python 3.12 is available via Homebrew (or 3.11+, minimum 3.10 per FastMCP requirement)
- **CORRECTED:** FastMCP is a standalone package (`fastmcp` v3.2.0 on PyPI), NOT `mcp.server.fastmcp`. Import: `from fastmcp import FastMCP`. Decorator: `@mcp.tool`.
- Cursor and Claude Desktop both support stdio-based MCP servers configured via JSON at `~/.cursor/mcp.json` and `~/Library/Application Support/Claude/claude_desktop_config.json`
- `uv` can manage the virtual environment and run the server in one command
- SQLite FTS5 is available in the Python 3.12 sqlite3 module (verified on macOS, but explicit startup check added)
- WAL mode + single writer with asyncio.Lock is sufficient for MCP concurrency (tools are called sequentially by each client, rarely concurrent)
- Memory DB is global (one DB, `project_id` column for filtering) -- not per-project

# Risks

- **Python 3.9.6 system Python may interfere**: Mitigated by using `uv` which manages its own Python
- **FastMCP v3 breaking changes**: Mitigated by pinning `>=3.2,<4` in pyproject.toml
- **FTS5 not available**: Explicit startup assertion added to fail fast
- **Concurrent writes from multiple MCP clients**: Mitigated by WAL mode + asyncio.Lock on write operations. Reads are lock-free under WAL.
- **Ingestion creating noisy/duplicate memories**: Mitigated by content_hash dedup, dry-run mode, and `is_active=0` default for heuristic extraction
- **Supersede cycles (A->B->C->A)**: Mitigated by DAG check before committing supersede links

# Validation Plan

After each phase:
- Phase 0: `uv run python -c "from fastmcp import FastMCP; print('OK')"` exits 0; FTS5 assertion passes
- Phase 1: `uv run pytest tests/test_db.py` -- all tests pass (add, search, supersede, cycle prevention, dedup, concurrent reads)
- Phase 2: `uv run python -m memory_server` starts without error; `Ctrl+C` exits cleanly; no stdout output (stderr only)
- Phase 3: Cursor MCP panel shows "memory" server with 9 tools; `ping` tool returns "ok"; Claude Desktop shows server connected
- Phase 4: `search_memory("bandcamp sales backfill")` returns relevant memories; `memory_stats()` shows correct type/project breakdown; dry-run shows preview before writing
- Phase 5: Backup file is valid SQLite that opens independently; stats include orphan/chain counts

# Rollback Plan

- Phase 0-2: Delete `/Users/Shared/WorkShared/mcp-memory` directory
- Phase 3: Revert `mcp.json` and Claude config to empty `mcpServers: {}`
- Phase 4-5: Memories are in a standalone SQLite file; delete the DB file to reset

# Rejected Alternatives

- **Build on Memento MCP directly**: Rejected per spec. Memento is reference only; building from scratch with official Python SDK gives full control over schema and tools.
- **Use Node.js MCP SDK**: Rejected. Python is the spec's chosen language, and the Python MCP SDK is mature.
- **Store memories in a JSON file**: Rejected. SQLite+FTS5 provides structured queries, full-text search, and ACID transactions. JSON would require building all of this manually.
- **Use PostgreSQL/Supabase**: Rejected. This is local-first by design. SQLite keeps it simple, portable, and zero-dependency.

# Open Questions

1. **Should the memory DB be per-project or global?** Plan follows global (one DB, `project_id` filter). Could revisit if DB grows very large.
2. **Memory ID generation**: UUIDv7 (chronological) vs content-hash-based (dedup-friendly). Plan uses UUIDv7 for sort order + separate `content_hash` for dedup.
3. **Memory size limits**: At high velocity, the DB could grow large. No pruning/archiving strategy yet. Monitor DB size and add if needed.
4. **Cross-project queries**: Schema supports it via `project_id` column. No dedicated cross-project tool yet -- `search_memory` with `project_id=None` searches all projects.
5. **Conflict resolution**: If Cursor and Claude Desktop both write a conflicting memory, last-write-wins (no CRDT). Acceptable for single-user system.

# Deferred Items

- **Vector search via embeddings**: Deferred until FTS5 proves insufficient. When needed, consider Ollama `nomic-embed-text` (stays resident, fast) over BGE-M3 (1.2GB cold load).
- **ChatGPT import**: Requires parsing ChatGPT export JSON format. Tier 2 priority from spec.
- **Validation agent**: An LLM that reviews and corrects ingested memories. Phase 5 from spec.
- **Codex / VS Code / Gemini CLI wiring**: Same MCP config pattern as Cursor/Claude. Verify each client's MCP transport support (stdio vs HTTP).
- **Memory decay/expiration**: Old assumptions could be auto-deprioritized. Add `valid_until` column later if needed.
- **Cross-project search**: Schema already supports via `project_id` column. UI/tool for cross-project queries deferred.
- **Cursor local DB extraction**: Cursor stores conversations in `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`. Format is version-dependent. Build extractor when stabilized.
- **LLM-assisted extraction**: Use Claude/local model to parse raw chat into structured memories with the extraction prompt from the review. Deferred to after manual ingestion proves the schema works.

# Revision History

- v1 (2026-04-04): Initial plan
- v2 (2026-04-04): Integrated 2 technical reviews. Changes:
  - **CRITICAL:** Fixed FastMCP import path (`from fastmcp import FastMCP`, not `from mcp.server.fastmcp`). Decorator is `@mcp.tool` not `@server.tool()`. Pin to v3.2+.
  - Added explicit 17-column schema with SQL (was "all 17 columns" without listing them)
  - Added Pydantic models for validation (MemoryRecord, MemoryLink, MemoryType, MemoryStatus enums)
  - Added WAL mode for concurrent read safety + asyncio.Lock for write serialization
  - Added 6 indexes (project, feature, type, active, status, links)
  - Added `content_hash` column for re-ingestion dedup detection
  - Added `status` (active/superseded/invalidated) and `confidence` (high/medium/low) columns
  - Added `tags` column (JSON array)
  - Added `ping` health-check tool and `memory_stats` debugging tool (9 tools total)
  - Added FTS5 availability assertion at startup
  - Added supersede cycle (DAG) prevention
  - Added provenance hashing (SHA256 + mtime) for ingestion
  - Added dry-run mode for ingestion preview
  - Added deterministic heading detection rules for markdown parsing
  - Changed backup to use `VACUUM INTO` (atomic) instead of Python file copy
  - Added logging to stderr (stdout reserved for MCP protocol)
  - Moved `memory_stats` from Phase 5 to Phase 2 (useful for debugging from the start)
