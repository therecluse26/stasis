/**
 * Physiological state persistence.
 *
 * State is written as a Pi `CustomEntry` via `pi.appendEntry`. Two properties of that
 * mechanism are why it was chosen over a file on disk:
 *
 *  1. **The model cannot see it.** Pi's `sessionEntryToContextMessages()` returns nothing
 *     for entries of type `custom`, so it is structurally impossible for the stored
 *     history to enter LLM context. The model receives a rendering of the *current*
 *     state and nothing else.
 *  2. **Branching is handled for free.** Entries are ordinary tree nodes parented to the
 *     session leaf, so `/fork` and `/tree` scope them correctly with no work here — a
 *     state file on disk would leak across branches.
 *
 * It also puts the record where the model cannot reach it with bash, which a state file
 * in the working tree would not.
 */

import type { StasisSnapshot } from "../runtime/stasis-runtime.ts";

/** Custom entry type. Namespaced so it cannot collide with another extension's. */
export const STASIS_STATE_ENTRY = "stasis:state";

/**
 * The slice of Pi's session manager this module needs.
 *
 * Structural rather than imported so persistence can be tested without a Pi session.
 */
export interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface BranchReader {
	getBranch(): readonly BranchEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Validate a restored snapshot rather than trusting whatever is in the session file. */
export function isStasisSnapshot(value: unknown): value is StasisSnapshot {
	if (!isRecord(value)) return false;
	if (value.version !== 1) return false;
	const state = value.state;
	if (!isRecord(state)) return false;
	for (const key of ["stress", "confidence", "noveltyDrive", "fatigue", "persistence"]) {
		const entry = state[key];
		if (typeof entry !== "number" || !Number.isFinite(entry)) return false;
	}
	return true;
}

/**
 * Most recent snapshot on the current branch.
 *
 * Walks the branch rather than the whole file so a fork sees only its own ancestry.
 */
export function findLatestSnapshot(reader: BranchReader): StasisSnapshot | undefined {
	let latest: StasisSnapshot | undefined;
	for (const entry of reader.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STASIS_STATE_ENTRY) continue;
		if (isStasisSnapshot(entry.data)) latest = entry.data;
	}
	return latest;
}

/** Every snapshot on the branch, oldest first — used by `/stasis history`. */
export function collectSnapshots(reader: BranchReader): StasisSnapshot[] {
	const snapshots: StasisSnapshot[] = [];
	for (const entry of reader.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STASIS_STATE_ENTRY) continue;
		if (isStasisSnapshot(entry.data)) snapshots.push(entry.data);
	}
	return snapshots;
}
