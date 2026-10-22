import { projectStoredEvent } from './analytics.js';
import type { AnalyticsRepository, DeliveryError } from './analytics-store.js';

export async function deliverAnalytics(repository:AnalyticsRepository,key?:string,send:typeof fetch=fetch) {
  if(!key)return {attempted:0,sent:0};
  const leases=await repository.claim(10);
  let sent=0;
  const results=await Promise.allSettled(leases.map(async lease=>{
    let error:DeliveryError|null=null;
    try {
      const response=await send('https://eu.i.posthog.com/i/v0/e/',{
        method:'POST',headers:{'content-type':'application/json'},redirect:'error',
        signal:AbortSignal.timeout(3000),
        body:JSON.stringify({api_key:key,uuid:lease.uuid,...projectStoredEvent(lease.event)}),
      });
      if(!response.ok)error='provider_rejected';
      try { await response.body?.cancel(); } catch { /* The response body is never read or stored. */ }
    } catch { error='network_unavailable'; }
    const acknowledged=await repository.finish(lease,error);
    if(acknowledged&&!error)sent++;
  }));
  if(results.some(result=>result.status==='rejected'))throw new Error('Analytics delivery persistence failed');
  return {attempted:leases.length,sent};
}
export function startAnalyticsWorker(repository:AnalyticsRepository,key?:string,onError:()=>void=()=>{}) {
  let stopping=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>=Promise.resolve();
  const tick=()=>{
    running=(async()=>{
      try { await repository.prune(); await deliverAnalytics(repository,key); }
      catch { onError(); }
      finally { if(!stopping)timer=setTimeout(tick,5000); }
    })();
  };
  tick();
  return async()=>{stopping=true;if(timer)clearTimeout(timer);await running;};
}
