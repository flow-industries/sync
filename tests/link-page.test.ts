import { expect, test } from "bun:test";
import { linkPageFor, NOTE_ORIGIN } from "../src/link-page";

test("the link page is NOTE's own, built from the user code alone", () => {
  expect(linkPageFor("BCDF-GHJK")).toBe(
    "https://note.flow.talk/link?code=BCDF-GHJK",
  );
  for (const userCode of [
    "BCDF-GHJK#passkey=eyJyZXF1ZXN0Ijp0cnVlfQ",
    "BCDF-GHJK&passkey=1",
    "../recover?code=BCDF-GHJK",
    "//evil.example/link",
  ]) {
    const url = new URL(linkPageFor(userCode));
    expect(url.origin).toBe(NOTE_ORIGIN);
    expect(url.pathname).toBe("/link");
    expect(url.hash).toBe("");
    expect([...url.searchParams.keys()]).toEqual(["code"]);
    expect(url.searchParams.get("code")).toBe(userCode);
  }
});
