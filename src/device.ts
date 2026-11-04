import { NoteChangedError } from "@flow-industries/seal";

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
