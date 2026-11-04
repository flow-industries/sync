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

/** A DNS TXT lookup, where the platform offers one (desktop): each record as its chunks. */
export type ResolveTxt = (name: string) => Promise<string[][]>;

async function answersOverHttps(
  handle: string,
  did: string,
  fetch: NoteDeviceFetch,
): Promise<boolean> {
  try {
    const response = await fetch(`https://${handle}/.well-known/atproto-did`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok && (await response.text()).trim() === did;
  } catch {
    return false;
  }
}

/** The DNS method: exactly one `did=` record at `_atproto.<handle>`, naming `did`. */
async function answersOverDns(
  handle: string,
  did: string,
  resolveTxt: ResolveTxt,
): Promise<boolean> {
  try {
    const claims = (await resolveTxt(`_atproto.${handle}`))
      .map((chunks) => chunks.join(""))
      .filter((record) => record.startsWith("did="));
    return claims.length === 1 && claims[0] === `did=${did}`;
  } catch {
    return false;
  }
}

/**
 * Names the account behind `did` by its handle, checked both ways: the DID
 * document claims the handle, and the handle's domain answers with the DID,
 * over HTTPS or, where the platform can look it up, DNS. A DID document
 * alone could claim anyone's handle. Anything unverifiable leaves just the
 * DID, which is what the link actually bound.
 */
export async function linkedAccount(
  did: string,
  fetch: NoteDeviceFetch,
  resolveTxt?: ResolveTxt,
): Promise<LinkedAccount> {
  try {
    const url = documentUrl(did);
    if (!url) return { did };
    const handle = claimedHandle(await getJson(fetch, url), did);
    if (!handle) return { did };
    if (
      (await answersOverHttps(handle, did, fetch)) ||
      (resolveTxt && (await answersOverDns(handle, did, resolveTxt)))
    )
      return { did, handle };
  } catch {
    // An account that can't be named still shows its DID.
  }
  return { did };
}

/**
 * The domain that vouched for a handle: everything after its first label,
 * or the whole handle when that leaves a bare top-level domain. A lookalike
 * such as `alice-flow.talk.example` reads as `talk.example` here.
 */
export function handleDomain(handle: string): string {
  const rest = handle.slice(handle.indexOf(".") + 1);
  return rest.includes(".") ? rest : handle;
}
