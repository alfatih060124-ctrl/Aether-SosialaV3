import pg from 'pg';

const { Pool } = pg;

export function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 10),
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
}
