import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
    all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    run() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: result.changes } }; }
  }
  return {
    sqlite,
    prepare(sql) { return new Statement(sql); },
    batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map((statement) => statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}
