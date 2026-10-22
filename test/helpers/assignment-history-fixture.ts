import type { AssignmentHistoryData } from '../../src/assignment-history.js';
export function historyFixture(): AssignmentHistoryData {
  return { courseId: '10', assignmentId: '90', state: 'available', coverage: 'school_returned', observedAt: '2099-10-03T00:00:00Z', currentAttempt: 2,
    items: [{ key: 'a'.repeat(64), attempt: 1, submittedAt: '2099-10-01T00:00:00Z', workflowState: 'submitted', submissionType: 'online_upload',
      content: { text: { state: 'not_applicable', value: null }, url: { state: 'not_applicable', value: null } },
      attachments: [{ id: '7', fileName: '합성 이전 답안.pdf', contentType: 'application/pdf', sizeBytes: 8, downloadAvailable: true }], isCurrent: false },
    { key: 'b'.repeat(64), attempt: 2, submittedAt: '2099-10-02T00:00:00Z', workflowState: 'submitted', submissionType: 'online_text_entry',
      content: { text: { state: 'available', value: '합성 본문\n두 번째 줄' }, url: { state: 'not_applicable', value: null } }, attachments: [], isCurrent: true }] };
}
export function schoolHistoryFixture() {
  const value = historyFixture(); return { ...value, items: value.items!.map(item => ({ ...item, key: 'a_' + item.key })) };
}
