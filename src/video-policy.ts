/** Whole-file/offset ceiling only. Media remains incremental, private and never fully buffered. */
export const maxSchoolVideoBytes = 4 * 1024 * 1024 * 1024;

/** These formats require a private proof of the exact issued single-video launch before callback binding. */
export function requiresVerifiedVideoMedia(resourceType: string | null | undefined): resourceType is 'readystream' | 'everlec' {
  return resourceType === 'readystream' || resourceType === 'everlec';
}
