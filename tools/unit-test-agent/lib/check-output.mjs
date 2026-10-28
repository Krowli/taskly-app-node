// Checks the agent's parsed agent-output.json against its JSON Schema. Only the keywords and types
// that schema uses are implemented; returns one message per problem, prefixed with its JSON path.
export const TYPES = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  integer: Number.isInteger,
}
export const KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'maxItems', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum']

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

export function checkOutput(value, schema, path = '') {
  const at = path || '(root)'
  if (schema.type && !TYPES[schema.type](value)) return [`${at}: expected ${schema.type}, got ${typeOf(value)}`]
  const errors = []
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`)
  if (typeof value === 'string') {
    const length = [...value].length // JSON Schema counts characters, not UTF-16 units
    if (length < (schema.minLength ?? 0)) errors.push(`${at}: has ${length} characters, at least ${schema.minLength} required`)
    if (length > (schema.maxLength ?? Infinity)) errors.push(`${at}: has ${length} characters, at most ${schema.maxLength} allowed`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`)
  }
  if (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) errors.push(`${at}: ${value} is below the minimum ${schema.minimum}`)
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? Infinity)) errors.push(`${at}: has ${value.length} items, at most ${schema.maxItems} allowed`)
    if (schema.items) value.forEach((item, i) => errors.push(...checkOutput(item, schema.items, `${path}[${i}]`)))
  } else if (TYPES.object(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}: missing required ${JSON.stringify(key)}`)
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...checkOutput(child, schema.properties[key], path ? `${path}.${key}` : key))
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${JSON.stringify(key)}`)
    }
  }
  return errors
}
