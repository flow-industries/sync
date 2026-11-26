import {
  NoteChangedError,
  parseSyncBackoff,
  SYNC_BUSY,
  SYNC_CONNECTION_FAILED,
  SYNC_QUOTA_REACHED,
  SYNC_TOO_LARGE,
  SYNCED,
  transientFailure,
} from "@flow-industries/seal";

/** The one place the plugin imports the NOTE device client from. */
export {
  AccessRemovedError,
  createDeviceSeed,
  type DeviceCheckpoint,
  type DeviceCheckpointStore,
  type DeviceOptions,
  type DeviceVault,
  deleteDeviceStorage,
  LINK_EXPIRED,
  LINK_UNVERIFIED,
  type LinkOptions,
  type LinkPrompt,
  linkDevice,
  type NoteDeviceCredentialStore,
  type NoteDeviceCredentials,
  type NoteDeviceFetch,
  openDeviceVault,
  SYNC_LOCKED,
  type SyncListener,
  type TrustLoss,
} from "@flow-industries/seal";

/** Whether a compare-and-swap write was refused because the item changed in NOTE since it was read. */
export const isStaleWrite = (error: unknown) =>
  error instanceof NoteChangedError;

/**
 * Whether the device publishes `status` only after a sync that read the
 * vault: one that went through, or one whose upload was refused for a full
 * quota or an oversized notepad, which the device reaches only after the
 * read. A rate limit can refuse the read itself, so it isn't one.
 */
export function followsRead(status: string): boolean {
  const refusal = parseSyncBackoff(status)?.refusal;
  return (
    status === SYNCED ||
    refusal === SYNC_QUOTA_REACHED ||
    refusal === SYNC_TOO_LARGE
  );
}

export const CONNECTION_FAILED =
  "The connection to Flow ID failed. Try again in a moment.";
export const UNAVAILABLE =
  "Flow ID isn't available right now. Try again in a moment.";
export const BUSY =
  "Flow ID is busy with other uploads from your account. Try again in a moment.";
export const REFUSED = "Flow ID couldn't complete that. Try again later.";

/** The code of a refusal Flow ID's SDK threw: a string `code` beside a numeric `status`. */
function refusalCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error) || !("status" in error)) return undefined;
  return typeof error.code === "string" && typeof error.status === "number"
    ? error.code
    : undefined;
}

/**
 * Words for a failure Flow ID reported by its code, so no code reaches the
 * person; undefined for any other failure, which says what went wrong itself.
 * A failed connection may be on either side, so its words blame neither.
 * `PDS_UNAVAILABLE` is also what an error page without a code reads as, such
 * as a gateway's during an outage.
 */
export function failureWords(error: unknown): string | undefined {
  const transient = transientFailure(error);
  if (transient === "connection") return CONNECTION_FAILED;
  if (transient === "busy") return BUSY;
  const code = refusalCode(error);
  if (code === "PDS_UNAVAILABLE") return UNAVAILABLE;
  return code === undefined ? undefined : REFUSED;
}

/** What the status bar says for a device status. A failed connection or a busy Flow ID reads as a wait, since the device retries on its own. */
export function statusWords(status: string): string {
  if (status === SYNC_CONNECTION_FAILED)
    return "Connection to Flow ID failed; changes are kept and sync resumes once it's back";
  if (status === SYNC_BUSY) return "Syncing again in a moment";
  return status;
}
