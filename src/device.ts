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

/**
 * Whether the device's last sync read the whole vault: it synced, or only
 * its upload was refused, which a full quota or an oversized notepad can do
 * only after the read. A rate limit can refuse the read itself, and pending,
 * blocked or unauthorized syncs may not have read anything, so the local
 * copy could still be the one from before, or empty on a new link.
 */
export function pulledStatus(status: string): boolean {
  const refusal = parseSyncBackoff(status)?.refusal;
  return (
    status === SYNCED ||
    refusal === SYNC_QUOTA_REACHED ||
    refusal === SYNC_TOO_LARGE
  );
}
/** Whether a compare-and-swap write was refused because the item changed in NOTE since it was read. */
export const isStaleWrite = (error: unknown) =>
  error instanceof NoteChangedError;
