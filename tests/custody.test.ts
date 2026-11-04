import { describe, expect, test } from "bun:test";
import { Custody, type SecretBackend } from "../src/custody";
import type { DeviceCheckpoint, NoteDeviceCredentials } from "../src/device";

/** Obsidian's secret storage: ids are lowercase alphanumeric with dashes, at most 64 characters. */
class Secrets implements SecretBackend {
  values = new Map<string, string>();
  get(id: string) {
    return this.values.get(id) ?? null;
  }
  set(id: string, value: string) {
    if (!/^[a-z0-9-]+$/u.test(id) || id.length > 64)
      throw new Error(`Invalid secret id ${id}`);
    this.values.set(id, value);
  }
  delete(id: string) {
    this.values.delete(id);
  }
}
const credentials: NoteDeviceCredentials = {
  accessToken: "fnd_access",
  refreshToken: "fndr_refresh",
  deviceId: "device",
  userId: "owner",
  did: "did:plc:abcdefghijklmnopqrstuvwx",
  accessExpiresAt: 1,
};
const checkpoint: DeviceCheckpoint = {
  vault: "vault",
  epoch: 1,
  pinned: {
    statement: "s",
    sequence: 1,
    admins: ["a"],
    recipients: ["a", "d"],
  },
  trust: "handed",
  runners: [{ recipientId: "a", signPublicKey: "k" }],
};

describe("custody", () => {
  test("keeps the seed, tokens, pin and confirmed account under valid secret ids", async () => {
    const secrets = new Secrets();
    const custody = new Custody(secrets, "0123456789abcdef");
    const seed = crypto.getRandomValues(new Uint8Array(32));
    custody.saveSeed(seed);
    await custody.credentials.write(credentials);
    await custody.checkpoints.write(checkpoint);
    custody.confirmAccount({
      did: credentials.did,
      handle: "alice.example.com",
    });
    expect(custody.seed()).toEqual(seed);
    expect(await custody.credentials.read()).toEqual(credentials);
    expect(await custody.checkpoints.read()).toEqual(checkpoint);
    expect(custody.account()).toEqual({
      did: credentials.did,
      handle: "alice.example.com",
    });
    expect(
      [...secrets.values.keys()].every((id) =>
        id.startsWith("flow-note-0123456789abcdef-"),
      ),
    ).toBe(true);
  });

  test("keeps two vaults' links apart in one shared store", async () => {
    const secrets = new Secrets();
    const one = new Custody(secrets, "aaaaaaaaaaaaaaaa");
    const two = new Custody(secrets, "bbbbbbbbbbbbbbbb");
    await one.credentials.write(credentials);
    expect(await two.credentials.read()).toBeNull();
  });

  test("unlinking wipes the seed, tokens and account but keeps the public pin", async () => {
    const secrets = new Secrets();
    const custody = new Custody(secrets, "0123456789abcdef");
    custody.saveSeed(new Uint8Array(32).fill(1));
    await custody.credentials.write(credentials);
    await custody.checkpoints.write(checkpoint);
    custody.confirmAccount({ did: credentials.did });
    custody.wipe();
    expect(custody.seed()).toBeNull();
    expect(await custody.credentials.read()).toBeNull();
    expect(custody.account()).toBeNull();
    expect(await custody.checkpoints.read()).toEqual(checkpoint);
  });

  test("reads anything malformed as absent, and refuses to store malformed credentials", async () => {
    const secrets = new Secrets();
    const custody = new Custody(secrets, "0123456789abcdef");
    secrets.set("flow-note-0123456789abcdef-seed", "c2hvcnQ");
    secrets.set("flow-note-0123456789abcdef-tokens", "{not json");
    secrets.set("flow-note-0123456789abcdef-pin", JSON.stringify({ vault: 1 }));
    expect(custody.seed()).toBeNull();
    expect(await custody.credentials.read()).toBeNull();
    expect(await custody.checkpoints.read()).toBeNull();
    await expect(
      custody.credentials.write({ ...credentials, did: "nope" }),
    ).rejects.toThrow("Invalid device credentials");
    expect(() => new Custody(secrets, "Has Spaces")).toThrow();
  });
});

test("a refresh that lands after a wipe writes nothing", async () => {
  const secrets = new Secrets();
  const custody = new Custody(secrets, "0123456789abcdef");
  const transport = custody.scope();
  await transport.credentials.write(credentials);
  custody.wipe();
  await transport.credentials.write({ ...credentials, refreshToken: "late" });
  await transport.checkpoints.write(checkpoint);
  expect(await custody.credentials.read()).toBeNull();
  expect(await custody.checkpoints.read()).toBeNull();
  await custody.scope().credentials.write(credentials);
  expect(await custody.credentials.read()).toEqual(credentials);
});
