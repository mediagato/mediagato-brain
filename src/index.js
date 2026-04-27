/**
 * @mediagato/brain — Local-first PGlite brain.
 *
 * Postgres everywhere. Same schema, same SQL, same tools — whether the brain
 * lives on Neon (SaaS) or PGlite (local). When sync ships, local brains and
 * cloud brains speak the same dialect. No translation layer.
 *
 * Intelligence data (memories, state, patterns, learned behaviors) lives on
 * the user's machine. Never on the SaaS. The SaaS is a relay for operational
 * data (jobs, presence, auth). The brain is local.
 *
 * Five tables:
 *   state          — key/value config and signals (e.g. director, current model)
 *   memories       — filename-keyed long-form notes
 *   steering       — routing/template entries with mode + match_pattern
 *   review_lessons — auto-generated rules from prior tasks
 *   brain_meta     — internal (brain_name, spore_seeded_at)
 *
 * Layer distinction on state/memories/steering: 'instance' (user-created) vs
 * 'pattern' (seeded from a Spore pack — template-level, not personal).
 */
const path = require('path');
const fs = require('fs');

let _db = null;
let _dbPath = null;
let _ready = false;

/**
 * Initialize the brain.
 * @param {string} dataDir - directory under which a 'brain/' subdir will be created
 * @returns {Promise<PGlite>} the underlying PGlite instance (advanced use only)
 */
async function init(dataDir) {
  const { PGlite } = require('@electric-sql/pglite');

  _dbPath = path.join(dataDir, 'brain');
  fs.mkdirSync(_dbPath, { recursive: true });

  _db = new PGlite(_dbPath);

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      layer TEXT DEFAULT 'instance',
      anonymizable BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS memories (
      filename TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      layer TEXT DEFAULT 'instance',
      anonymizable BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS steering (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'always',
      match_pattern TEXT,
      priority INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT true,
      layer TEXT DEFAULT 'instance',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_lessons (
      id SERIAL PRIMARY KEY,
      task_type TEXT NOT NULL,
      rule TEXT NOT NULL,
      source_item_id INTEGER,
      layer TEXT DEFAULT 'instance',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brain_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  _ready = true;
  // Log to stderr so MCP servers using stdio transport don't see the message
  // on stdout. Electron consumers (Companion) capture both streams via their
  // own logger, so this is a no-op for them.
  console.error(`[brain] PGlite initialized at ${_dbPath}`);
  return _db;
}

function _ts() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function _ensure() {
  if (!_ready) throw new Error('Brain not initialized. Call init() first.');
}

/** Get the database directory path. */
function dbPath() { return _dbPath; }

/** Get this brain's name. Default: Bob. */
async function getName() {
  _ensure();
  const result = await _db.query("SELECT value FROM brain_meta WHERE key = 'brain_name'");
  return result.rows[0] ? result.rows[0].value : 'Bob';
}

/** Name this brain. */
async function setName(name) {
  _ensure();
  await _db.query(`
    INSERT INTO brain_meta (key, value) VALUES ('brain_name', $1)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
  `, [name]);
}

// ── State operations ──────────────────────────────────────────────────────

async function getState(key) {
  _ensure();
  const result = await _db.query(
    'SELECT value, layer, updated_at FROM state WHERE key = $1', [key]
  );
  return result.rows[0] || null;
}

async function setState(key, value, updatedBy = 'brain') {
  _ensure();
  await _db.query(`
    INSERT INTO state (key, value, updated_by, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at
  `, [key, value, updatedBy, _ts()]);
}

async function getAllState() {
  _ensure();
  const result = await _db.query('SELECT key, value, layer, updated_at FROM state ORDER BY key');
  return result.rows;
}

async function deleteState(key) {
  _ensure();
  await _db.query('DELETE FROM state WHERE key = $1', [key]);
}

// ── Memory operations ─────────────────────────────────────────────────────

async function getMemory(filename) {
  _ensure();
  const result = await _db.query(
    'SELECT content, layer, updated_at FROM memories WHERE filename = $1', [filename]
  );
  return result.rows[0] || null;
}

async function setMemory(filename, content, updatedBy = 'brain', layer = 'instance') {
  _ensure();
  await _db.query(`
    INSERT INTO memories (filename, content, updated_by, updated_at, layer)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(filename) DO UPDATE SET
      content = EXCLUDED.content,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at,
      layer = EXCLUDED.layer
  `, [filename, content, updatedBy, _ts(), layer]);
}

async function getAllMemories() {
  _ensure();
  const result = await _db.query('SELECT filename, layer, updated_at FROM memories ORDER BY filename');
  return result.rows;
}

// ── Spore seed ────────────────────────────────────────────────────────────

/**
 * Seed the brain from a Spore payload.
 * Idempotent — ON CONFLICT DO NOTHING on every insert. Pattern-layer data only.
 * @param {Object} sporeData - { state: [{key, value}], memories: [{filename, content}], steering: [...] }
 */
async function seedFromSpore(sporeData) {
  _ensure();
  const ts = _ts();
  let count = 0;

  if (sporeData.state) {
    for (const s of sporeData.state) {
      await _db.query(`
        INSERT INTO state (key, value, updated_by, updated_at, layer, anonymizable)
        VALUES ($1, $2, 'spore', $3, 'pattern', true)
        ON CONFLICT(key) DO NOTHING
      `, [s.key, s.value, ts]);
      count++;
    }
  }

  if (sporeData.memories) {
    for (const m of sporeData.memories) {
      await _db.query(`
        INSERT INTO memories (filename, content, updated_by, updated_at, layer, anonymizable)
        VALUES ($1, $2, 'spore', $3, 'pattern', true)
        ON CONFLICT(filename) DO NOTHING
      `, [m.filename, m.content, ts]);
      count++;
    }
  }

  if (sporeData.steering) {
    for (const s of sporeData.steering) {
      await _db.query(`
        INSERT INTO steering (id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, true, 'pattern', $7, $7)
        ON CONFLICT(id) DO NOTHING
      `, [s.id, s.name, s.content, s.mode || 'always', s.match_pattern || null, s.priority || 0, ts]);
      count++;
    }
  }

  await _db.query(`
    INSERT INTO brain_meta (key, value) VALUES ('spore_seeded_at', $1)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
  `, [ts]);

  console.error(`[brain] seeded ${count} items from Spore`);
  return count;
}

/** Check if this brain has been seeded from a Spore. Returns the timestamp or null. */
async function isSeeded() {
  _ensure();
  const result = await _db.query("SELECT value FROM brain_meta WHERE key = 'spore_seeded_at'");
  return result.rows[0] ? result.rows[0].value : null;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

async function close() {
  if (_db) {
    await _db.close();
    _db = null;
    _ready = false;
    console.error('[brain] closed');
  }
}

module.exports = {
  init,
  dbPath,
  getName,
  setName,
  getState,
  setState,
  getAllState,
  deleteState,
  getMemory,
  setMemory,
  getAllMemories,
  seedFromSpore,
  isSeeded,
  close,
};
