/**
 * Takes the Web Lock `name` and holds it until the returned function is
 * called; null when someone else still holds it after `wait` ms. Locks span
 * every window of this app's origin, and a plugin reloaded in this window
 * waits here while its predecessor's last requests settle. Without Web
 * Locks, nothing is held.
 */
export function holdLock(
  name: string,
  wait: number,
  locks: LockManager | undefined = window.navigator?.locks,
): Promise<(() => void) | null> {
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    locks
      .request(name, { signal: AbortSignal.timeout(wait) }, async () => {
        resolve(release);
        await held;
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "TimeoutError")
          resolve(null);
        else reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}
