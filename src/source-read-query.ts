import { z } from 'zod';
import type { SourceReadOptions } from './provider.js';

/** Public revalidation intent; callers cannot supply ownership, catalog or generation proof. */
export const sourceRefresh = z.enum(['1', 'resource']);
export const sourceReadQuery = z.object({ refresh: sourceRefresh.optional() }).strict();
export function sourceReadOptions(refresh?: z.infer<typeof sourceRefresh>): SourceReadOptions {
  return refresh ? { refresh: true, ...(refresh === 'resource' ? { refreshScope: 'resource' as const } : {}) } : {};
}
