/**
 * Return true only for plain-object payloads that can be safely used as
 * named parameter maps in prepared Cypher execution.
 *
 * Validation criteria:
 * - must be a JavaScript object (`typeof value === 'object'`)
 * - must not be `null`
 * - must not be an array
 * - must have a plain-object prototype
 * - each value must be either a scalar bindable value (string | number |
 *   boolean | null) OR an array whose elements are all such scalars
 *
 * The array-of-scalars case (R2) is required so callers can bind a list for
 * `WHERE n.id IN $ids`. Nested objects, functions, and arrays containing
 * non-scalars (including nested arrays) are still rejected, keeping binding
 * behavior predictable and avoiding passing complex host objects to Ladybug
 * parameter binding.
 */
const isBindableScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const isBindableParamValue = (value: unknown): boolean =>
  isBindableScalar(value) || (Array.isArray(value) && value.every(isBindableScalar));

export const isValidQueryParams = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.values(value).every(isBindableParamValue);
