import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// JSON records keep the hackathon schema flexible; SQLite persists all writes.
export function createStore(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));');
  if (db.prepare('PRAGMA table_info(records)').all().filter(column => column.pk).length === 1) {
    db.exec('BEGIN IMMEDIATE; ALTER TABLE records RENAME TO records_legacy; CREATE TABLE records (id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id)); INSERT INTO records SELECT id,kind,body FROM records_legacy; DROP TABLE records_legacy; COMMIT;');
  }
  db.exec('CREATE INDEX IF NOT EXISTS records_kind ON records(kind);');
  const putStatement = db.prepare('INSERT INTO records(id,kind,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body');
  const store = {
    list(kind) { return db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(row => JSON.parse(row.body)); },
    get(kind, id) { const row = db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.body) : null; },
    put(kind, record) { const value = { id: randomUUID(), createdAt: new Date().toISOString(), ...record, updatedAt: new Date().toISOString() }; putStatement.run(value.id, kind, JSON.stringify(value)); return value; },
    event(type, detail, entityId) { return store.put('events', { type, detail, entityId }); },
    transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    close() { db.close(); }
  };
  return store;
}

export function seedStore(store) {
  if (store.get('meta', 'seed-v1')) return;
  store.transaction(() => {
    for (const [i, stage] of ['Foundation', 'Framing', 'Exterior', 'Interiors'].entries()) {
      store.put('assets', { id: `demo-asset-${i + 1}`, name: `${stage} · sample illustration`, project: 'Cedar House', stage, kind: 'image', url: `/assets/house.svg?stage=${i}`, demo: true });
    }
    store.put('meta', { id: 'seed-v1' });
  });
}
