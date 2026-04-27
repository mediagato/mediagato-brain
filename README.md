# @mediagato/brain

A local-first PGlite memory engine. State, memories, steering, and spore seeding — all on the user's machine. Same Postgres dialect as the SaaS-side brain, no translation layer.

## Why this exists

Intelligence data — memories, learned patterns, personal context — should live on the user's machine, not on a server. This package is the substrate that makes that real:

- **PGlite** for the database (Postgres compiled to WASM, runs in-process)
- **Five tables** mirroring how a brain thinks: `state`, `memories`, `steering`, `review_lessons`, `brain_meta`
- **Layer distinction** between `instance` (user-created) and `pattern` (template-seeded)
- **Spore seeding** for one-time setup with profession-specific patterns

It is the load-bearing engine across MEDiAGATO products that need persistent local memory: Companion (worker fleet brain), Mr. Mags (memory-only product for Claude Desktop, free for teachers forever — [mrmags.org](https://mrmags.org)), and any future tool that wants the same primitive.

## Install

```bash
npm install @mediagato/brain
```

## Usage

```js
const brain = require('@mediagato/brain');

// Initialize against any directory; a 'brain/' subdir is created inside it.
await brain.init(process.env.HOME);

// State — key/value config
await brain.setState('profession', 'teacher');
const profession = await brain.getState('profession');
// { value: 'teacher', layer: 'instance', updated_at: '2026-04-27T...' }

// Memories — filename-keyed long-form content
await brain.setMemory('lesson_plan_template.md', '# Lesson Plan\n...');
const note = await brain.getMemory('lesson_plan_template.md');

// Spore seed — one-time setup with pattern-layer templates
await brain.seedFromSpore({
  state: [{ key: 'subject_default', value: 'biology' }],
  memories: [{ filename: 'rubric.md', content: '# Rubric template' }],
  steering: [{ id: 'tone', name: 'Tone', content: 'Plain language.' }],
});

// Idempotent — re-seeding never overwrites user data
await brain.isSeeded();  // → timestamp string after first seed

// Cleanup on app quit
await brain.close();
```

## API

### Lifecycle
- `init(dataDir)` — open the database under `dataDir/brain/`. Returns the underlying PGlite instance.
- `dbPath()` — return the on-disk path of the database.
- `close()` — close the database and release file handles.

### Brain identity
- `getName()` — returns the brain's name. Default: `'Bob'`.
- `setName(name)` — set the brain's name.

### State
- `getState(key)` — return `{ value, layer, updated_at }` or `null`.
- `setState(key, value, updatedBy?)` — upsert. `updatedBy` defaults to `'brain'`.
- `getAllState()` — return all rows ordered by key.
- `deleteState(key)` — remove the row.

### Memories
- `getMemory(filename)` — return `{ content, layer, updated_at }` or `null`.
- `setMemory(filename, content, updatedBy?, layer?)` — upsert. Layer defaults to `'instance'`.
- `getAllMemories()` — return metadata for all memories (filename, layer, updated_at).

### Spore seed
- `seedFromSpore(sporeData)` — idempotent insert of pattern-layer templates. Pass `{ state, memories, steering }`. Returns the count of rows attempted.
- `isSeeded()` — return the seed timestamp or `null`.

## Schema

```sql
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  layer TEXT DEFAULT 'instance',
  anonymizable BOOLEAN DEFAULT true
);

CREATE TABLE memories (
  filename TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  layer TEXT DEFAULT 'instance',
  anonymizable BOOLEAN DEFAULT true
);

CREATE TABLE steering (
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

CREATE TABLE review_lessons (
  id SERIAL PRIMARY KEY,
  task_type TEXT NOT NULL,
  rule TEXT NOT NULL,
  source_item_id INTEGER,
  layer TEXT DEFAULT 'instance',
  created_at TEXT NOT NULL
);

CREATE TABLE brain_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## License

MIT — see [LICENSE](LICENSE).
