import type { NoteDeviceFetch } from "./device";

/** The account a link bound this vault to, as shown before the first upload. */
export interface LinkedAccount {
  did: string;
  /** Set only when the DID document names it and the handle points back at the DID. */
  handle?: string;
}

const PLC_DIRECTORY = "https://plc.directory";
const HANDLE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/u;
const TIMEOUT_MS = 8_000;

async function getJson(fetch: NoteDeviceFetch, url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

function documentUrl(did: string): string | null {
  if (/^did:plc:[a-z2-7]{24}$/u.test(did)) return `${PLC_DIRECTORY}/${did}`;
  const web = /^did:web:([a-z0-9.-]+)$/u.exec(did)?.[1];
  return web && HANDLE.test(web) ? `https://${web}/.well-known/did.json` : null;
}

function claimedHandle(document: unknown, did: string): string | null {
  if (typeof document !== "object" || document === null) return null;
  const { id, alsoKnownAs } = document as {
    id?: unknown;
    alsoKnownAs?: unknown;
  };
  if (id !== did || !Array.isArray(alsoKnownAs)) return null;
  const handle = alsoKnownAs
    .find(
      (alias): alias is string =>
        typeof alias === "string" && alias.startsWith("at://"),
    )
    ?.slice("at://".length)
    .toLowerCase();
  return handle && HANDLE.test(handle) ? handle : null;
}

/**
 * Names the account behind `did` by its handle, checked both ways: the DID
 * document claims the handle, and the handle's domain answers with the DID.
 * A DID document alone could claim anyone's handle. Anything unverifiable
 * leaves just the DID, which is what the link actually bound.
 */
export async function linkedAccount(
  did: string,
  fetch: NoteDeviceFetch,
): Promise<LinkedAccount> {
  try {
    const url = documentUrl(did);
    if (!url) return { did };
    const handle = claimedHandle(await getJson(fetch, url), did);
    if (!handle) return { did };
    const response = await fetch(`https://${handle}/.well-known/atproto-did`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok && (await response.text()).trim() === did)
      return { did, handle };
  } catch {
    // An account that can't be named still shows its DID.
  }
  return { did };
}
