/** Dynamic allowlist rule ids live well clear of static rule ids. */
export const ALLOWLIST_RULE_BASE = 100_000;

/**
 * Priority of the dynamic allowlist rules. Must outrank every static rule, or
 * that rule keeps firing on an allowlisted site. It was 1,000,000, which looked
 * generous until measured: AdGuard's converter emits 119 rules at or above
 * that, peaking at 1,000,302 in ubo-unbreak. build/validate.ts asserts every
 * static rule stays below this, importing the same constant the worker uses.
 */
export const ALLOWLIST_PRIORITY = 2_000_000_000;
