/** Quiet this long after the last request settles before a closed device counts as idle. */
const SETTLE_MS = 250;
const POLL_MS = 50;

/**
 * A device transport's requests and credential writes still in flight. Its
 * lock must outlive a token refresh it already sent: a second transport that
 * read the store before that refresh's write would present the rotated
 * token, which Flow ID takes for a replay and revokes the device.
 */
export class Traffic {
  private pending = 0;
  private last = 0;

  /** Runs `work` as part of this traffic. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.pending++;
    this.last = Date.now();
    try {
      return await work();
    } finally {
      this.pending--;
      this.last = Date.now();
    }
  }

  /** Settles once nothing has been in flight for a moment, or after `limit` ms at most. */
  async idle(limit: number): Promise<void> {
    const deadline = Date.now() + limit;
    while (
      Date.now() < deadline &&
      (this.pending > 0 || Date.now() - this.last < SETTLE_MS)
    )
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
