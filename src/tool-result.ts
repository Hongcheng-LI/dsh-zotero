/**
 * Normalisation shared by every registered tool.
 *
 * DSH validates a tool's returned value as lossless JSON: a single explicit
 * `undefined` property anywhere in the object graph marks the whole result as an
 * INVALID_TOOL_OUTPUT. Zotero's optional fields naturally produce `undefined`
 * through helpers such as `str()` — for example Zotero 10 returns
 * `parentCollection: false` for top-level collections, which maps to `undefined`
 * — so every tool result crosses a JSON round-trip before it leaves the plugin.
 */
export function toLosslessJson<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}
