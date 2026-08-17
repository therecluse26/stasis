/**
 * Model configuration for a trial.
 *
 * Nothing here selects a model — the study file does that. This owns the one adjustment
 * the harness makes to a resolved model: pinning which upstream provider serves it.
 *
 * OpenRouter routes a single model id to whichever provider is cheapest or fastest at the
 * moment, and those providers differ in quantization and occasionally in tokenizer. Between
 * two arms of a study that difference does not cancel out; it lands on the comparison. The
 * effect is wider for an open-weight model, which may be served by a dozen providers, than
 * for a first-party one served by its author.
 */

import type { BenchmarkModel } from "./types.ts";

/**
 * The only part of a resolved model this touches. Deliberately structural rather than the
 * SDK's `Model<Api>`: `compat` is a union discriminated on the API, and narrowing it here
 * would tie the harness to one provider's shape for no benefit.
 */
interface RoutableModel {
	compat?: object;
}

/**
 * Attach a study's routing preferences to a resolved model.
 *
 * Returns a copy: the resolved model comes from the shared catalog, and a study should not
 * leave marks on it. Models from other providers, and studies that did not ask for a pin,
 * are returned unchanged.
 */
export function applyRouting<T extends RoutableModel>(model: T, config: BenchmarkModel): T {
	if (config.provider !== "openrouter" || !config.routing) return model;
	return { ...model, compat: { ...(model.compat ?? {}), openRouterRouting: config.routing } } as T;
}
