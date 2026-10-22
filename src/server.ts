import { PlaybackStartService } from './playback-start-service.js';
import { createPlaybackStartSchool } from './playback-start-school.js';
import { createJobResultCache } from './job-result-cache.js';
import { withSchoolPlayback } from './playback-bootstrap.js';
import { ManualVideoService } from './manual-video-service.js';
import { PgPlaybackLeaseRepository } from './manual-video-lease.js';
import { createManualVideoSchool } from './manual-video-school.js';
import { createApiResourceCloser, apiShutdownHardLimitMs } from './api-shutdown.js';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { PgStore } from './store.js';
import { buildApp } from './app.js';
import { createSchoolProvider } from './school-adapter.js';
import { createSaintReader } from './saint-reader.js';
import { PgSchoolReadCache } from './school-read-cache.js';
import { createSyllabusRuntime } from './syllabus-runtime.js';
import { AssignmentSubmissionService } from './assignment-submission-service.js';
import { PgSubmissionRepository } from './assignment-submission-store.js';
import { createAssignmentSubmissionSchool } from './assignment-submission-school.js';
import { createLearningxReader } from './school-reader.js';
import { installedPlaybackIdentity, PgPlaybackReadiness } from './playback-worker-readiness.js';
import { createMcpAuthorization } from './mcp-auth/index.js';
import { createMcpReadTools } from './mcp-tools/index.js';
import { registerMcpRoutes } from './mcp-routes.js';
const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl,max: 10,connectionTimeoutMillis: 5000,statement_timeout:5000,query_timeout:5000 });
const store = new PgStore(pool);
const schoolCache = config.sessionEncryptionKey ? new PgSchoolReadCache(pool, config.sessionEncryptionKey) : undefined;
const reader = process.env.SSU_READ_ENABLED === 'true' && config.sessionEncryptionKey
  ? createLearningxReader(store, config.sessionEncryptionKey, undefined, undefined, schoolCache, undefined, undefined, createSyllabusRuntime()) : undefined;
const saint = process.env.SSU_SAINT_READ_ENABLED === 'true' && config.sessionEncryptionKey
  ? createSaintReader(store, config.sessionEncryptionKey, undefined, schoolCache) : undefined;
const manualVideo = reader && config.sessionEncryptionKey ? new ManualVideoService(new PgPlaybackLeaseRepository(pool),createManualVideoSchool(store,config.sessionEncryptionKey,(owner,course,activity)=>reader.invalidate(owner,course,activity))) : undefined;
const playbackStart = reader && config.sessionEncryptionKey ? new PlaybackStartService(new PgPlaybackLeaseRepository(pool),createPlaybackStartSchool(store,config.sessionEncryptionKey,(owner,course,activity)=>reader.invalidate(owner,course,activity))) : undefined;
const submissionRepo = reader && config.sessionEncryptionKey ? new PgSubmissionRepository(pool,config.sessionEncryptionKey) : undefined;
const submissions = submissionRepo && reader && config.sessionEncryptionKey ? new AssignmentSubmissionService(submissionRepo,createAssignmentSubmissionSchool(store,config.sessionEncryptionKey,(owner,course)=>reader.invalidate(owner,course),schoolCache),diagnostic=>console.warn(JSON.stringify(diagnostic))) : undefined;
if(submissionRepo)await submissionRepo.cleanup();
await store.cleanupFrontendAuthCodes();
const cleanupTimer=setInterval(()=>{void store.cleanupFrontendAuthCodes().catch(()=>{});if(submissionRepo)void submissionRepo.cleanup().catch(()=>{});},60000).unref();
let provider = createSchoolProvider(process.env.SSU_AUTH_ENABLED === 'true', reader, undefined, saint, globalThis.fetch, config.playbackEnabled);
if (config.playbackEnabled) {
  if (!reader || !config.sessionEncryptionKey || !provider.capabilities.schoolAuthentication) throw new Error('PLAYBACK_DEPENDENCIES_UNAVAILABLE');
  provider = withSchoolPlayback(provider, store, config.sessionEncryptionKey, (owner,course,activity) => reader.invalidate(owner,course,activity));
}
const playbackReadiness = config.playbackEnabled ? new PgPlaybackReadiness(pool, await installedPlaybackIdentity(config.commit)) : undefined;
const jobResultCache = reader ? createJobResultCache((owner, targets, signal) => reader.invalidateActivities(owner, targets, signal)) : undefined;
const app = await buildApp(config,store,provider,submissions,manualVideo,playbackReadiness,jobResultCache,playbackStart);
const mcp = config.mcp ? createMcpAuthorization({
  ...config.mcp, apiOrigin: config.apiOrigin, frontendOrigin: config.frontendOrigin, store, pool,
  encryptionKey: config.sessionEncryptionKey!, cookieName: config.cookieName,
}) : undefined;
if (mcp && config.mcp) {
  await mcp.register(app);
  await registerMcpRoutes(app, { ...config.mcp, apiOrigin: config.apiOrigin, allowedOrigins: config.allowedOrigins,
    version: config.version, authenticate: mcp.authenticate, tools: createMcpReadTools({ provider, store }),
  });
}
const closeResources = createApiResourceCloser([
  () => mcp?.close() ?? Promise.resolve(),
  () => submissions?.close() ?? Promise.resolve(),
  () => manualVideo?.close() ?? Promise.resolve(),
  () => playbackStart?.close() ?? Promise.resolve(),
], () => pool.end());
app.addHook('onClose',async () => { if(cleanupTimer)clearInterval(cleanupTimer);await closeResources(); });
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { submissions?.stop();manualVideo?.beginShutdown();playbackStart?.beginShutdown();setTimeout(()=>process.exit(1),apiShutdownHardLimitMs).unref();void app.close().catch(()=>process.exit(1)); });
await app.listen({ host: config.host,port: config.port });
