import { expect, test } from "bun:test";
import {
  SYNC_PENDING,
  SYNC_QUOTA_REACHED,
  SYNC_RATE_LIMITED,
  SYNC_TOO_LARGE,
  SYNCED,
} from "@flow-industries/seal";
import { pulledStatus } from "../src/device";

test("only a sync that read the whole vault counts as pulled", () => {
  const backoff = (refusal: string) => `${refusal} · Next sync 12:00`;
  expect(pulledStatus(SYNCED)).toBe(true);
  expect(pulledStatus(backoff(SYNC_QUOTA_REACHED))).toBe(true);
  expect(pulledStatus(backoff(SYNC_TOO_LARGE))).toBe(true);
  // A rate limit can refuse the read itself, so a new link would plan against an empty vault.
  expect(pulledStatus(backoff(SYNC_RATE_LIMITED))).toBe(false);
  expect(pulledStatus(SYNC_PENDING)).toBe(false);
});
