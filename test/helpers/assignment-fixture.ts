import type { AssignmentDetailData, AssignmentListData } from '../../src/assignments.js';
export function assignmentFixture(): AssignmentDetailData {
  return { id: '90', courseId: '10', moduleItemId: null, title: '합성 과제', dueAt: '2099-10-03T14:59:00.000Z',
    unlockAt: null, lockAt: null, published: true, lockedForUser: false, submissionTypes: ['online_upload'], allowedExtensions: null,
    pointsPossible: 100, allowedAttempts: -1, sourceUrl: 'https://canvas.ssu.ac.kr/courses/10/assignments/90',
    submissionState: 'available', submission: { workflowState: 'submitted', submissionType: 'online_upload', attempt: 1,
      submittedAt: '2099-10-02T00:00:00.000Z', gradedAt: null, late: false, missing: false, excused: null,
      gradeMatchesCurrentSubmission: true, postedAt: null, resultVisibility: 'not_posted', scoreState: 'missing', gradeState: 'missing',
      attachments: [{ id: '7', fileName: '합성 답안.pdf', contentType: 'application/pdf', sizeBytes: 1234, downloadAvailable: false }], feedback: [] },
    descriptionText: '합성 과제 안내\n두 번째 문단', lockExplanationText: null,
    descriptionAttachments: [], ownSubmittedContent: null };
}
export function assignmentListFixture(): AssignmentListData {
  const { descriptionText: _description, lockExplanationText: _lock, descriptionAttachments: _files, ownSubmittedContent: _content, ...summary } = assignmentFixture();
  return { courseId: '10', items: [summary], complete: true };
}
