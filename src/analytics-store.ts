import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ANALYTICS_MONTHLY_ATTEMPT_LIMIT, ANALYTICS_RETENTION_DAYS, type AnalyticsEvent } from './analytics.js';
import { AppError } from './errors.js';

export type DeliveryError = 'network_unavailable' | 'provider_rejected';
export type DeliveryLease = { uuid: string; token: string; attempts: number; event: AnalyticsEvent };
export type AnalyticsSummary = {
  days: number; from: string; through: string; retentionDays: number;
  totals: { events: number; sessions: number };
  counts: Array<{eventName: string; screen: string; count: number}>;
  frontends: Array<{clientId: string | null; uiVersion: string; count: number}>;
  durations: Array<{operation: string; outcome: string; count: number; averageMs: number; p95Ms: number}>;
  errors: Array<{code: string; operation: string; count: number}>;
  buttons: Array<{action: string; surface: string; count: number}>;
  categories: Array<{group: string; selected: string; count: number}>;
  delivery: { pending: number; sent: number; retryPending: number };
};
export interface AnalyticsRepository {
  persist(userId: string,event: AnalyticsEvent): Promise<'stored'|'duplicate'>;
  summarize(userId: string|null,days: number): Promise<AnalyticsSummary>;
  claim(limit?: number): Promise<DeliveryLease[]>;
  finish(lease: DeliveryLease,error: DeliveryError|null): Promise<boolean>;
  prune(): Promise<number>;
  deliveryBudget(): Promise<{month: string; attempts: number; limit: number}>;
}
export class PgAnalyticsStore implements AnalyticsRepository {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(run:(client:PoolClient)=>Promise<T>,readOnly=false):Promise<T> {
    const client=await this.pool.connect();
    try { await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result=await run(client); await client.query('COMMIT'); return result;
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async persist(userId:string,event:AnalyticsEvent):Promise<'stored'|'duplicate'> {
    return this.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('analytics:owner:' || $1,0))",[userId]);
      const existing=await client.query('SELECT payload=$3::jsonb AS same FROM analytics_events WHERE user_id=$1 AND event_id=$2',[userId,event.eventId,JSON.stringify(event)]);
      if(existing.rowCount) {
        if(!existing.rows[0].same) throw new AppError(409,'EVENT_ID_CONFLICT','같은 이벤트 ID에 다른 내용이 있습니다.');
        return 'duplicate';
      }
      const rate=await client.query("SELECT count(*)::int AS count FROM analytics_events WHERE user_id=$1 AND received_at>now()-interval '1 minute'",[userId]);
      if(rate.rows[0].count>=120) throw new AppError(429,'RATE_LIMITED','사용 기록 요청이 잠시 많습니다. 조금 뒤 다시 시도해 주세요.');
      const uuid=randomUUID();
      await client.query('INSERT INTO analytics_events(user_id,event_id,delivery_uuid,occurred_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[userId,event.eventId,uuid,event.occurredMinute,JSON.stringify(event)]);
      await client.query('INSERT INTO analytics_delivery(delivery_uuid) VALUES($1)',[uuid]);
      return 'stored';
    });
  }
  async summarize(userId:string|null,days:number):Promise<AnalyticsSummary> {
    if(!Number.isInteger(days)||days<1||days>365) throw new AppError(400,'INVALID_REQUEST','조회 기간은 1일부터 365일까지입니다.');
    const through=new Date(),from=new Date(through.getTime()-days*86400000);
    const params=[userId,from.toISOString(),through.toISOString()];
    const where='($1::uuid IS NULL OR e.user_id=$1) AND e.occurred_at >= $2 AND e.occurred_at <= $3';
    return this.transaction(async client=>{
      const totals=(await client.query(`SELECT count(*)::int AS events,count(DISTINCT payload->>'sessionId')::int AS sessions FROM analytics_events e WHERE ${where}`,params)).rows[0];
      const counts=(await client.query(`SELECT payload->>'eventName' AS "eventName",payload->>'screen' AS screen,count(*)::int AS count FROM analytics_events e WHERE ${where} GROUP BY 1,2 ORDER BY 1,2`,params)).rows;
      const frontends=(await client.query(`SELECT payload->>'clientId' AS "clientId",payload->>'uiVersion' AS "uiVersion",count(*)::int AS count FROM analytics_events e WHERE ${where} GROUP BY 1,2 ORDER BY 1,2`,params)).rows;
      const durations=(await client.query(`SELECT payload->'properties'->>'operation' AS operation,payload->'properties'->>'outcome' AS outcome,count(*)::int AS count,round(avg((payload->'properties'->>'duration_ms')::numeric))::int AS "averageMs",round(percentile_cont(0.95) WITHIN GROUP(ORDER BY (payload->'properties'->>'duration_ms')::int))::int AS "p95Ms" FROM analytics_events e WHERE ${where} AND payload->>'eventName'='interaction_duration' GROUP BY 1,2 ORDER BY 1,2`,params)).rows;
      const groups=async (event:string,first:string,second:string)=> (await client.query(`SELECT payload->'properties'->>'${first}' AS "${first}",payload->'properties'->>'${second}' AS "${second}",count(*)::int AS count FROM analytics_events e WHERE ${where} AND payload->>'eventName'=$4 GROUP BY 1,2 ORDER BY 1,2`,[...params,event])).rows;
      const errors=await groups('normalized_error','code','operation');
      const buttons=await groups('button_click','action','surface');
      const categories=await groups('category_select','group','selected');
      const delivery=(await client.query(`SELECT count(*) FILTER(WHERE d.delivered_at IS NULL)::int AS pending,count(*) FILTER(WHERE d.delivered_at IS NOT NULL)::int AS sent,count(*) FILTER(WHERE d.delivered_at IS NULL AND d.last_error IS NOT NULL)::int AS "retryPending" FROM analytics_events e JOIN analytics_delivery d USING(delivery_uuid) WHERE ${where}`,params)).rows[0];
      return {days,from:from.toISOString(),through:through.toISOString(),retentionDays:ANALYTICS_RETENTION_DAYS,totals,counts,frontends,durations,errors,buttons,categories,delivery};
    },true);
  }
  async claim(limit=10):Promise<DeliveryLease[]> {
    if(!Number.isInteger(limit)||limit<1||limit>10) throw new Error('Delivery batches contain 1 to 10 events');
    return this.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext('analytics:delivery-budget'))");
      const month="date_trunc('month',now() AT TIME ZONE 'UTC')::date";
      await client.query(`INSERT INTO analytics_delivery_budget(month) VALUES(${month}) ON CONFLICT DO NOTHING`);
      const budget=(await client.query(`SELECT attempts FROM analytics_delivery_budget WHERE month=${month}`)).rows[0].attempts;
      const remaining=Math.min(limit,ANALYTICS_MONTHLY_ATTEMPT_LIMIT-budget);
      if(remaining<=0)return [];
      const token=randomUUID();
      const claimed=await client.query(`WITH candidates AS (
        SELECT d.delivery_uuid FROM analytics_delivery d JOIN analytics_events e USING(delivery_uuid)
        WHERE d.delivered_at IS NULL AND d.next_attempt_at<=now() AND (d.lease_until IS NULL OR d.lease_until<=now())
          AND e.occurred_at>now()-interval '365 days'
        ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED
      ) UPDATE analytics_delivery d SET attempts=d.attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds'
        FROM candidates c WHERE d.delivery_uuid=c.delivery_uuid RETURNING d.delivery_uuid,d.attempts`,[remaining,token]);
      if(!claimed.rowCount)return [];
      await client.query(`UPDATE analytics_delivery_budget SET attempts=attempts+$1 WHERE month=${month}`,[claimed.rowCount]);
      const payloads=await client.query('SELECT delivery_uuid,payload FROM analytics_events WHERE delivery_uuid=ANY($1::uuid[])',[claimed.rows.map(row=>row.delivery_uuid)]);
      return claimed.rows.map(row=>({uuid:row.delivery_uuid,token,attempts:row.attempts,event:payloads.rows.find(value=>value.delivery_uuid===row.delivery_uuid)!.payload}));
    });
  }
  async finish(lease:DeliveryLease,error:DeliveryError|null):Promise<boolean> {
    const delaySeconds=Math.min(3600,5*2**Math.min(lease.attempts-1,10));
    const result=await this.pool.query(`UPDATE analytics_delivery SET delivered_at=CASE WHEN $3::text IS NULL THEN now() ELSE NULL END,
      last_error=$3,next_attempt_at=now()+$4*interval '1 second',lease_token=NULL,lease_until=NULL
      WHERE delivery_uuid=$1 AND lease_token=$2 AND delivered_at IS NULL`,[lease.uuid,lease.token,error,delaySeconds]);
    return Boolean(result.rowCount);
  }
  async prune():Promise<number> {
    const result=await this.pool.query("WITH expired AS (SELECT user_id,event_id FROM analytics_events WHERE occurred_at<now()-interval '365 days' LIMIT 1000) DELETE FROM analytics_events e USING expired x WHERE e.user_id=x.user_id AND e.event_id=x.event_id");
    await this.pool.query("DELETE FROM analytics_receipts WHERE received_at<now()-interval '365 days'");
    await this.pool.query("DELETE FROM analytics_delivery_budget WHERE month<(date_trunc('month',now() AT TIME ZONE 'UTC')-interval '13 months')::date");
    return result.rowCount??0;
  }
  async deliveryBudget() {
    const row=(await this.pool.query("SELECT to_char(date_trunc('month',now() AT TIME ZONE 'UTC'),'YYYY-MM') AS month,COALESCE((SELECT attempts FROM analytics_delivery_budget WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0) AS attempts")).rows[0];
    return {month:row.month,attempts:row.attempts,limit:ANALYTICS_MONTHLY_ATTEMPT_LIMIT};
  }
}
