import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { linkedAccount } from "../src/account";
import type { NoteDeviceFetch } from "../src/device";
import { type RequestUrl, requestUrlFetch } from "../src/fetch";
import { IndexedDbIndex } from "../src/index-store";

describe("fetch over requestUrl", () => {
  test("passes method, headers and bytes through, and answers a real Response", async () => {
    const seen: Parameters<RequestUrl>[0][] = [];
    const fetch = requestUrlFetch(async (request) => {
      seen.push(request);
      return {
        status: 409,
        headers: { "content-type": "application/json" },
        arrayBuffer: new TextEncoder().encode('{"code":"CONFLICT"}')
          .buffer as ArrayBuffer,
      };
    });
    const bytes = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);
    const response = await fetch("https://id.example/upload", {
      method: "POST",
      headers: { Authorization: "Bearer fnd_x" },
      body: bytes,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CONFLICT" });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.authorization).toBe("Bearer fnd_x");
    expect(seen[0]?.throw).toBe(false);
    expect([...new Uint8Array(seen[0]?.body as ArrayBuffer)]).toEqual([8, 7]);
  });

  test("stops waiting when aborted, and keeps bodiless statuses bodiless", async () => {
    const never = requestUrlFetch(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = never("https://id.example/token", {
      signal: controller.signal,
    });
    controller.abort(new Error("gone"));
    await expect(pending).rejects.toThrow("gone");
    const empty = requestUrlFetch(async () => ({
      status: 204,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    }));
    expect((await empty("https://id.example/x", {})).status).toBe(204);
  });
});

describe("the linked account", () => {
  const did = "did:plc:abcdefghijklmnopqrstuvwx";
  const serve =
    (routes: Record<string, () => Response>): NoteDeviceFetch =>
    async (url) =>
      routes[url]?.() ?? new Response("not found", { status: 404 });

  test("names the handle only when the handle points back at the DID", async () => {
    const document = { id: did, alsoKnownAs: ["at://alice.example.com"] };
    const verified = serve({
      [`https://plc.directory/${did}`]: () => Response.json(document),
      "https://alice.example.com/.well-known/atproto-did": () =>
        new Response(`${did}\n`),
    });
    expect(await linkedAccount(did, verified)).toEqual({
      did,
      handle: "alice.example.com",
    });
    const claimedOnly = serve({
      [`https://plc.directory/${did}`]: () => Response.json(document),
      "https://alice.example.com/.well-known/atproto-did": () =>
        new Response("did:plc:someoneelse"),
    });
    expect(await linkedAccount(did, claimedOnly)).toEqual({ did });
    expect(
      await linkedAccount(did, async () => {
        throw new Error("offline");
      }),
    ).toEqual({ did });
    expect(await linkedAccount("did:example:x", verified)).toEqual({
      did: "did:example:x",
    });
  });
});

describe("the sync index", () => {
  test("persists in its own IndexedDB database", async () => {
    const factory = new IDBFactory();
    const index = new IndexedDbIndex("flow-note-sync:test", factory);
    expect(await index.load()).toEqual([]);
    const entry = {
      id: "a",
      path: "A.md",
      revision: "r",
      digest: "d",
      hash: "h",
      mtime: 1,
      size: 2,
    };
    await index.save([entry]);
    expect(
      await new IndexedDbIndex("flow-note-sync:test", factory).load(),
    ).toEqual([entry]);
  });
});
