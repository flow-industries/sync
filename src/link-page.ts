/** Where approving a link happens. */
export const NOTE_ORIGIN = "https://note.flow.talk";

/**
 * NOTE's link page for a Flow ID user code, built here. It is never an
 * address Flow ID chose, whose path, query or fragment could lead the person
 * to a request other than this vault's.
 */
export function linkPageFor(userCode: string): string {
  const url = new URL("/link", NOTE_ORIGIN);
  url.searchParams.set("code", userCode);
  return url.href;
}
