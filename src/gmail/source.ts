import { existsSync, readFileSync } from "node:fs";
import type { Store } from "../store/db.js";
import type { Email } from "../types.js";

/** Anything that yields new emails. Gmail in production, a JSON file in end-to-end tests. */
export interface EmailSource {
  poll(store: Store, query: string): Promise<Email[]>;
}

/**
 * Reads emails from a JSON file (an array of Email objects) on every poll and returns
 * the ones not processed yet. Enabled only when IBO_TEST_INBOX points to a file, so
 * end-to-end tests can drive the real daemon without a Google account.
 */
export class FixtureSource implements EmailSource {
  constructor(private readonly file: string) {}

  async poll(store: Store): Promise<Email[]> {
    if (!existsSync(this.file)) return [];
    const all = JSON.parse(readFileSync(this.file, "utf8")) as Email[];
    return all.filter((e) => !store.hasEmail(e.id));
  }
}
