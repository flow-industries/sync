/**
 * Takes the Web Lock `name` without waiting and holds it until the returned
 * function is called; null when someone else holds it. Locks span every
 * window of this app's origin. Without Web Locks, nothing is held.
 */
export function holdLock(
  name: string,
  locks: LockManager | undefined = globalThis.navigator?.locks,
): Promise<(() => void) | null> {
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) return resolve(null);
        resolve(release);
        await held;
      })
      .catch(reject);
  });
}
