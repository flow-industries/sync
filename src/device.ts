import {
  NoteChangedError,
  parseSyncBackoff,
  SYNC_QUOTA_REACHED,
  SYNC_TOO_LARGE,
  SYNCED,
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
