import fs from 'node:fs/promises';
import path from 'node:path';

export async function runMigrations(pool, migrationsDir = path.resolve(process.cwd(), 'migrations')) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
}
