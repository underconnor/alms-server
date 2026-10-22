/** Serialize jar refreshes across school readers for one owner; other owners run independently. */
const pending = new Map<string, Promise<unknown>>();
export function withSchoolSessionLock<T>(owner: string, run: () => Promise<T>): Promise<T> {
  const previous = pending.get(owner) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  pending.set(owner, next);
  void next.finally(() => { if (pending.get(owner) === next) pending.delete(owner); }).catch(() => {});
  return next;
}
