import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from './contracts/ux-events.schema.json' with { type: 'json' };
import type { Session } from './domain.js';
import type { AnalyticsRepository } from './analytics-store.js';
import { AppError } from './errors.js';

export const ANALYTICS_RETENTION_DAYS = 365;
export const ANALYTICS_MONTHLY_ATTEMPT_LIMIT = 900_000;
export type AnalyticsEvent = {
  eventId: string; eventName: string; analyticsId: string; sessionId: string;
  occurredMinute: string; sessionSequence: number; uiVersion: string; screen: string;
  clientId?: string;
  properties: Record<string, unknown>;
};
const ajv = new Ajv2020({ allErrors: false, strict: false });
(addFormats as unknown as (ajv: Ajv2020) => void)(ajv);
const validate = ajv.compile(schema);
export function validateEvent(value: unknown): asserts value is Record<string, any> {
  if (!validate(value)) throw new AppError(400,'INVALID_EVENT','허용되지 않은 분석 이벤트입니다.');
}
function canonicalEvent(value: Record<string, any>, session: Session): AnalyticsEvent {
  return {
    eventId: value.event_id, eventName: value.event_name,
    analyticsId: session.user.analyticsId, sessionId: session.analyticsSessionId,
    occurredMinute: value.occurred_minute, sessionSequence: value.session_sequence,
    uiVersion: value.ui_version, screen: value.screen,
    ...(session.clientId ? { clientId: session.clientId } : {}),
    properties: structuredClone(value.properties),
  };
}
export function projectStoredEvent(value: AnalyticsEvent) {
  return {
    event: 'alms_' + value.eventName, distinct_id: value.analyticsId,
    timestamp: value.occurredMinute,
    properties: {
      schema_version: '1', event_id: value.eventId,
      session_id: value.sessionId, session_sequence: value.sessionSequence,
      ui_version: value.uiVersion, screen: value.screen,
      ...(value.clientId ? { client_id: value.clientId } : {}),
      $process_person_profile: false, $geoip_disable: true,
      details: value.properties,
    },
  };
}
export function projectEvent(value: Record<string, any>, session: Session) {
  return projectStoredEvent(canonicalEvent(value,session));
}
export async function captureEvent(value: unknown, session: Session, repository: AnalyticsRepository) {
  validateEvent(value);
  const age = Date.now() - Date.parse(value.occurred_minute);
  if (age > 24 * 60 * 60 * 1000 || age < -5 * 60 * 1000) {
    throw new AppError(400,'EVENT_TOO_OLD','이벤트 시각을 확인해 주세요.');
  }
  // Legacy preferences and provider keys never gate required local collection.
  const reason = await repository.persist(session.user.id,canonicalEvent(value,session));
  return { accepted: true, reason };
}
