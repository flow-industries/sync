import type { NoteDeviceFetch } from "./device";

/** The part of Obsidian's `requestUrl` this adapter uses. */
export type RequestUrl = (request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
  throw: false;
}) => Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}>;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

async function bodyOf(
  body: RequestInit["body"],
): Promise<string | ArrayBuffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body))
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    );
  if (body instanceof Blob) return body.arrayBuffer();
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("Unsupported request body");
}

const reasonOf = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("The request was aborted.");

function aborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(reasonOf(signal));
    signal.addEventListener("abort", () => reject(reasonOf(signal)), {
      once: true,
    });
  });
}

/**
 * `fetch` over Obsidian's `requestUrl`, which isn't held to CORS on desktop
 * or mobile. `requestUrl` can't be cancelled, so an abort only stops waiting:
 * the device client already refuses anything that arrives after its deadline.
 */
export function requestUrlFetch(requestUrl: RequestUrl): NoteDeviceFetch {
  return async (url, init) => {
    init.signal?.throwIfAborted();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const response = await Promise.race([
      requestUrl({
        url,
        method: init.method ?? "GET",
        headers,
        body: await bodyOf(init.body),
        throw: false,
      }),
      aborted(init.signal),
    ]);
    return new Response(
      NULL_BODY.has(response.status) ? null : response.arrayBuffer,
      { status: response.status, headers: response.headers },
    );
  };
}
