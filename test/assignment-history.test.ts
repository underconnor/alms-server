import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError } from '@alms/ssu-api';
import { bindAssignmentHistory, publicAssignmentHistory, assignmentHistoryAttemptHandle } from '../src/assignment-history.js';
import { historyFixture, schoolHistoryFixture } from './helpers/assignment-history-fixture.js';
const bad = (run: () => unknown) => assert.throws(run, error => error instanceof SchoolError && error.code === 'unexpected_response');
test('own history preserves missing/null/empty and school-returned coverage without promoting grades or school identities', () => {
  for (const state of ['missing', 'null'] as const) assert.deepEqual(publicAssignmentHistory({ ...historyFixture(), state, items: null }, '10', '90').items, null);
  assert.deepEqual(publicAssignmentHistory({ ...historyFixture(), items: [] }, '10', '90').items, []);
  const source = historyFixture(), result = publicAssignmentHistory({ ...source, userId: 'private-user', complete: true, sourceUrl: 'https://private.invalid/signed',
    items: source.items!.map(item => ({ ...item, score: 99, grade: 'private-grade', userId: 'private-user', url: 'https://private.invalid/signed' })) }, '10', '90');
  assert.equal(result.coverage, 'school_returned'); assert.equal(Object.hasOwn(result, 'complete'), false);
  assert.doesNotMatch(JSON.stringify(result), /private-|score|grade|sourceUrl|userId/);
});
test('history content retains field states, empty text and safe user-submitted URL only for its submission type', () => {
  for (const state of ['missing', 'null', 'not_applicable'] as const) {
    const source = historyFixture(); source.items![1]!.content.text = { state, value: null };
    assert.equal(publicAssignmentHistory(source, '10', '90').items![1]!.content.text.state, state);
  }
  const source = historyFixture(), own = source.items![1]!;
  own.content.text = { state: 'available', value: '' }; assert.equal(publicAssignmentHistory(source, '10', '90').items![1]!.content.text.value, '');
  own.submissionType = 'online_url'; own.content.text = { state: 'not_applicable', value: null }; own.content.url = { state: 'available', value: 'https://example.org/submitted' };
  assert.equal(publicAssignmentHistory(source, '10', '90').items![1]!.content.url.value, 'https://example.org/submitted');
  own.content.url = { state: 'available', value: '' };
  assert.equal(publicAssignmentHistory(source, '10', '90').items![1]!.content.url.value, '');
  for (const value of ['javascript:alert(1)', 'https://user:password@example.org/', 'https://example.org/\nprivate', 'https://example.org/\\private']) {
    own.content.url = { state: 'available', value }; bad(() => publicAssignmentHistory(source, '10', '90'));
  }
});
test('history rejects identity mismatches, conflicting attempts, unknown arrays and invalid content associations', () => {
  for (const mutate of [
    (value: ReturnType<typeof historyFixture>) => { value.courseId = '20'; }, value => { value.assignmentId = '91'; },
    value => { value.state = 'missing'; }, value => { value.items = null; },
    value => { value.items![1]!.attempt = 1; }, value => { value.items![1]!.key = value.items![0]!.key; },
    value => { value.items![0]!.isCurrent = true; }, value => { value.items![1]!.attempt = null; },
    value => { value.items![0]!.attachments!.push(value.items![0]!.attachments![0]!); },
    value => { value.items![0]!.attempt = 0; }, value => { value.items![1]!.attempt = 0; value.currentAttempt = 0; },
    value => { value.items![1]!.submissionType = 'online_quiz'; },
  ]) { const value = historyFixture(); mutate(value); bad(() => publicAssignmentHistory(value, '10', '90')); }
  bad(() => publicAssignmentHistory({ ...historyFixture(), items: {} }, '10', '90'));
  bad(() => publicAssignmentHistory({ ...historyFixture(), items: Array(101).fill(historyFixture().items![0]) }, '10', '90'));
});
test('history preserves available read evidence with unknown or unsubmitted school workflow without enabling writes', () => {
  for (const workflowState of ['unknown', 'unsubmitted'] as const) {
    const source = historyFixture(); source.items!.forEach(item => { item.workflowState = workflowState; });
    const result = publicAssignmentHistory(source, '10', '90');
    assert.equal(result.items![0]!.attachments![0]!.downloadAvailable, true);
    assert.equal(result.items![1]!.content.text.state, 'available');
    assert.equal(result.items![0]!.workflowState, workflowState);
  }
});
test('history handles bind verified school keys to owner/generation/course/assignment and never expose SDK/raw IDs', () => {
  const key = Buffer.alloc(32, 1), source = schoolHistoryFixture();
  const result = bindAssignmentHistory(source, '10', '90', 'owner-one', 'generation-one', key), handle = result.items![0]!.key;
  assert.match(handle, /^[a-f0-9]{64}$/); assert.notEqual(handle, source.items[0]!.key);
  assert.equal(bindAssignmentHistory(source, '10', '90', 'owner-one', 'generation-one', key).items![0]!.key, handle);
  assert.notEqual(bindAssignmentHistory(source, '10', '90', 'owner-two', 'generation-one', key).items![0]!.key, handle);
  assert.notEqual(bindAssignmentHistory(source, '10', '90', 'owner-one', 'generation-two', key).items![0]!.key, handle);
  assert.notEqual(assignmentHistoryAttemptHandle(source.items[0]!.key, '20', '90', 'owner-one', 'generation-one', key), handle);
  assert.notEqual(assignmentHistoryAttemptHandle(source.items[0]!.key, '10', '91', 'owner-one', 'generation-one', key), handle);
  source.items[0]!.key = 'raw-user-id'; bad(() => bindAssignmentHistory(source, '10', '90', 'owner-one', 'generation-one', key));
});
test('history one-MiB projection limit cannot publish a partial oversized success', () => {
  const value = historyFixture(); value.items = Array.from({ length: 8 }, (_, index) => ({ ...value.items![1]!, key: (index + 1).toString(16).padStart(64, '0'), attempt: index + 3,
    isCurrent: false, content: { text: { state: 'available' as const, value: 'x'.repeat(180_000) }, url: { state: 'not_applicable' as const, value: null } } }));
  assert.throws(() => publicAssignmentHistory(value, '10', '90'), { code: 'unsupported' });
});
