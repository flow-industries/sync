import {
  NoteChangedError,
  parseSyncBackoff,
  SYNC_BUSY,
  SYNC_QUOTA_REACHED,
  SYNC_TOO_LARGE,
  SYNC_UNREACHABLE,
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

export const UNREACHABLE =
  "Couldn't reach Flow ID. Your changes are kept; try again once it's back.";
export const BUSY =
  "Flow ID is busy. Your changes are kept; try again in a moment.";

/** Words for a failure Flow ID reported by its code, so no code reaches the person: undefined for any other failure. */
export function failureWords(error: unknown): string | undefined {
  const transient = transientFailure(error);
  if (transient === "connection") return UNREACHABLE;
  if (transient === "busy") return BUSY;
  return undefined;
}

/** What the status bar says for a device status. Flow ID out of reach or busy reads as a wait, since the device retries on its own. */
export function statusWords(status: string): string {
  if (status === SYNC_UNREACHABLE)
    return "Couldn't reach Flow ID; changes are kept and will sync when it's back";
  if (status === SYNC_BUSY) return "Syncing again in a moment";
  return status;
}
