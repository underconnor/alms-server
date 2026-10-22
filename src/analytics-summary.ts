import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { PgAnalyticsStore } from './analytics-store.js';
const args=process.argv.slice(2);
if(args.some(value=>!/^--days=\d{1,3}$/.test(value))||args.length>1)throw new Error('Usage: npm run analytics:summary -- --days=7');
const days=args.length?Number(args[0]!.split('=')[1]):7;
if(!Number.isInteger(days)||days<1||days>365)throw new Error('days must be between 1 and 365');
const config=loadConfig(),pool=new Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
try {
  const repository=new PgAnalyticsStore(pool),summary=await repository.summarize(null,days);
  process.stdout.write(JSON.stringify({...summary,delivery:{...summary.delivery,configured:Boolean(config.posthogKey),destination:config.posthogKey?'posthog_eu':'local'},budget:await repository.deliveryBudget()},null,2)+'\n');
} finally {await pool.end();}
