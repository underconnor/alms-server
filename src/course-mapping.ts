import type { Course } from './school-read.js';
import type { Schedule } from './saint-reader.js';

export type CourseMapping = {
  status: 'matched' | 'ambiguous' | 'unmatched';
  method: 'code_section' | 'title_professor' | null;
  candidateCourseIds: string[];
};
type Identifiers = { courseCode?: string | null; section?: string | null };
type MappingCourse = Course & Identifiers;
type MappingSchedule = Schedule & Identifiers;
export type MappedSchedule = Schedule & { courseMapping: CourseMapping };

const label = (value: string | null | undefined) => (value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
/** Recognize the observed academic term labels; unknown labels must not enable a cross-term match. */
export function courseTerm(value: string | null | undefined): string | null {
  const match = /^(20\d{2})(?:학년도|년도|년)(1학기|2학기|여름학기|겨울학기)$/.exec(label(value).replace(/\s+/gu, ''));
  return match ? `${match[1]}:${match[2]}` : null;
}
// Observed LMS titles append a ten-digit registration code in parentheses; Saint omits it.
// This removes display decoration only: the number is never inferred to be a course or section identity.
const courseTitle = (value: string) => label(value).replace(/\s*\(\d{10}\)$/, '').trim();
const ids = (courses: readonly MappingCourse[]) => [...new Set(courses.map(course => course.id))].sort();

/** Only the observed comma-separated LMS list can establish an exact professor membership. */
function professorInList(professor: string | null | undefined, professors: string | null | undefined): boolean {
  const ambiguous = /[;|/\\&+\u00b7\u3001\uff0c\r\n()[\]{}]/u;
  if (!professor || !professors || professor.includes(',') || ambiguous.test(professor) || ambiguous.test(professors)) return false;
  const expected = label(professor), members = professors.split(',').map(label);
  const completeItem = (member: string) => Boolean(member && !member.includes(',') && !ambiguous.test(member));
  return Boolean(completeItem(expected) && members.length > 1 && members.every(completeItem)
    && new Set(members).size === members.length && members.includes(expected));
}

/** Match within this owner's catalog and the school-selected term. Never use a fuzzy title or the first candidate. */
export function mapScheduleCourses(entries: readonly MappingSchedule[], courses: readonly MappingCourse[], term: string | null): MappedSchedule[] {
  const selectedTerm = courseTerm(term);
  const sameTerm = selectedTerm ? courses.filter(course => courseTerm(course.term) === selectedTerm) : [];
  return entries.map(entry => {
    const titleCandidates = label(entry.courseTitle) ? sameTerm.filter(course => courseTitle(course.title) === label(entry.courseTitle)) : [];
    const code = label(entry.courseCode), section = label(entry.section);
    // Current Saint/catalog readers do not expose these identifiers; use only explicit future verified fields.
    const codeCandidates = code && section ? sameTerm.filter(course => label(course.courseCode) === code && label(course.section) === section) : [];
    const codeAvailable = Boolean(code && section && sameTerm.some(course => label(course.courseCode) && label(course.section)));
    const professorCandidates = label(entry.professor)
      ? titleCandidates.filter(course => label(course.professor) === label(entry.professor)) : [];
    // Preserve strict matches and ambiguity; a list membership cannot choose among same-title sections.
    const listCandidates = !codeAvailable && professorCandidates.length === 0 && titleCandidates.length === 1
      && professorInList(entry.professor, titleCandidates[0]!.professor) ? titleCandidates : [];
    const matches = ids(codeAvailable ? codeCandidates : professorCandidates.length ? professorCandidates : listCandidates);
    const suggestions = matches.length ? matches : ids(titleCandidates);
    const courseMapping: CourseMapping = {
      status: matches.length === 1 ? 'matched' : suggestions.length > 1 ? 'ambiguous' : 'unmatched',
      method: matches.length === 1 ? codeAvailable ? 'code_section' : 'title_professor' : null,
      candidateCourseIds: suggestions,
    };
    return { ...entry, courseId: matches.length === 1 ? matches[0]! : null, courseMapping };
  });
}
