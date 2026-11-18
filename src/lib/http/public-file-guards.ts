import { TtlSet } from "./ttl-set";

/**
 * S-04: "not found" answers given to ANONYMOUS callers of GET /api/v1/files/:id, remembered for 5 minutes
 * (at most 5,000 ids per instance) so repeated probes don't query the database. Only anonymous answers are
 * cached: a signed-in, authorized user is never refused because of it. New uploads get new random ids.
 */
export const anonymousFileMisses = new TtlSet(5 * 60 * 1000, 5000);
