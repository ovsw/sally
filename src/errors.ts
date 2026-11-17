/** A request the rules service refuses. */
export class RuleError extends Error {}

/** A request about a rule, version or match that does not exist. */
export class RuleNotFoundError extends RuleError {}
