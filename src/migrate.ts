import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { migrate } from './migrations.js';
const pool = new Pool({ connectionString: loadConfig().databaseUrl });
try { await migrate(pool); process.stdout.write('ALMS migrations applied\n'); }
finally { await pool.end(); }
