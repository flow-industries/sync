import { localRuntime } from "@flow-industries/seal/internal/app/local-runtime";
import {
  type CheckpointPolicy,
  savedCheckpoint,
  signedState,
  type UnlockPort,
} from "@flow-industries/seal/internal/app/unlock";
import { passkeyAdmin } from "@flow-industries/seal/internal/crypto/access-v3";
import { AuthVaultTransport } from "@flow-industries/seal/internal/sync/vault-transport";
import {
  type AdminBrowser,
  type FakeFlowId,
  TEST_DID,
} from "@flow-industries/seal/internal/testing/kit";

const did = TEST_DID;

/**
 * NOTE starting a new notepad over the current one, as a passkey the notepad
 * doesn't list does: a brand-new vault (new id, new key, epoch 1, a signed
 * `create` listing only that passkey) published over the existing record,
 * compare-and-swap against the record it read. Every linked device loses
 * its notepad at once. Built like seal's own test `adminBrowser`, whose
 * vault can only be the first one, and returned in its shape, so the
 * kit's `approveLink` and `openAdminVault` work on the new notepad.
 */
export async function startOver(note: FakeFlowId): Promise<AdminBrowser> {
  const replaced = note.record();
  if (!replaced) throw new Error("No notepad to start over");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const admin = await passkeyAdmin(prf, "recreated", did);
  const state = await signedState(
    key,
    { did, vault: crypto.randomUUID(), epoch: 1 },
    {
      kind: "create",
      sequence: 1,
      recipients: [admin.recipient],
      signer: admin,
    },
    "created",
  );
  const created = new AuthVaultTransport(note.browserRpc, {
    key,
    did,
    ...state,
  });
  try {
    await created.writeSnapshot([], replaced.cid);
  } finally {
    created.stop();
  }
  let checkpoint: CheckpointPolicy | null = savedCheckpoint(state);
  const port: UnlockPort = {
    current: () => ({
      userId: "owner",
      did,
      credentialId: "recreated",
      sessionVersion: 1,
    }),
    checkpoint: async () => checkpoint,
    saveCheckpoint: async (value) => {
      checkpoint = value;
    },
    resolve: async () => ({ did, active: true, authorized: true }),
    readHeader: async () => {
      const current = note.record();
      return current ? { header: current.value, cid: current.cid } : null;
    },
    publish: async (publishedKey, published, expectedCid) => {
      const reader = new AuthVaultTransport(note.browserRpc, {
        key: publishedKey,
        did,
        ...published,
        pinned: null,
      });
      const previous = await reader.readSnapshot();
      reader.stop();
      if (previous?.cid !== expectedCid)
        throw new Error("Vault changed during publish");
      const writer = new AuthVaultTransport(note.browserRpc, {
        key: publishedKey,
        did,
        ...published,
      });
      await writer.writeSnapshot(previous.entries, expectedCid);
      writer.stop();
    },
    evaluatePrf: async () => prf.slice(),
    runtime: (session) => localRuntime(session),
  };
  return { note, key, port, state, admin };
}
