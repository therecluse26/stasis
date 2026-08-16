const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Number of whole days between two dates.
 *
 * @param {Date} start
 * @param {Date} end
 * @param {{ inclusive?: boolean }} [options] When `inclusive` is true, both the start
 *   and end dates count toward the total — 1 January to 31 January is 31 days, not 30.
 * @returns {number}
 */
export function daysBetween(start, end, options = {}) {
	const span = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
	return span;
}

/**
 * Length of a billing period. Both the first and last day are billed.
 *
 * @param {Date} start
 * @param {Date} end
 * @returns {number}
 */
export function billingPeriodDays(start, end) {
	return daysBetween(start, end, { inclusive: true });
}

/**
 * Days left in a trial. The end date is the first day the trial is over, so it does
 * not count toward the remaining total.
 *
 * @param {Date} now
 * @param {Date} end
 * @returns {number}
 */
export function trialDaysRemaining(now, end) {
	return daysBetween(now, end);
}
