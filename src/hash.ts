const encoder = new TextEncoder();

/** Hex SHA-256 of a note's UTF-8 text or an attachment's bytes. */
export async function sha256(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
