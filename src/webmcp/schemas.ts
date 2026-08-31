import type { JsonSchemaForInference } from '@mcp-b/webmcp-types'

export type Schema = Record<string, unknown>
export type StrictJsonSchema = JsonSchemaForInference & Schema

export const objectSchema = (properties: Record<string, JsonSchemaForInference>, required: string[] = []) =>
  ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }) as StrictJsonSchema

export const idSchema = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9._:-]+$' } as const
const point = objectSchema(
  {
    x: { type: 'integer', minimum: -10_000_000, maximum: 10_000_000 },
    y: { type: 'integer', minimum: -10_000_000, maximum: 10_000_000 },
  },
  ['x', 'y'],
)
const wall = objectSchema(
  {
    id: idSchema,
    start: point,
    end: point,
    thicknessMm: { type: 'integer', minimum: 60, maximum: 600 },
    finish: { type: 'string', maxLength: 240 },
  },
  ['id', 'start', 'end', 'thicknessMm'],
)
const opening = objectSchema(
  {
    id: idSchema,
    wallId: idSchema,
    kind: { type: 'string', enum: ['door', 'window'] },
    offsetMm: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    widthMm: { type: 'integer', minimum: 100, maximum: 100_000 },
    swing: { type: 'string', enum: ['left', 'right', 'sliding'] },
  },
  ['id', 'wallId', 'kind', 'offsetMm', 'widthMm'],
)
const roomMarker = objectSchema(
  { id: idSchema, name: { type: 'string', minLength: 1, maxLength: 100 }, position: point },
  ['id', 'name', 'position'],
)
const furniture = objectSchema(
  {
    id: idSchema,
    kind: { type: 'string', minLength: 1, maxLength: 100 },
    label: { type: 'string', maxLength: 160 },
    position: point,
    widthMm: { type: 'integer', minimum: 1, maximum: 100_000 },
    depthMm: { type: 'integer', minimum: 1, maximum: 100_000 },
    rotationDegrees: { type: 'number', minimum: -3600, maximum: 3600 },
  },
  ['id', 'kind', 'label', 'position', 'widthMm', 'depthMm', 'rotationDegrees'],
)
const mutationGroup = (entity: Schema) =>
  objectSchema({
    upsert: { type: 'array', items: entity, minItems: 1, maxItems: 50 },
    remove: { type: 'array', items: idSchema, minItems: 1, maxItems: 50 },
  })
export const layoutPatchSchema = objectSchema({
  walls: mutationGroup(wall),
  openings: mutationGroup(opening),
  roomMarkers: mutationGroup(roomMarker),
  furniture: mutationGroup(furniture),
})
export const styleSchema = objectSchema(
  {
    roomId: idSchema,
    floorMaterial: { type: 'string', minLength: 1, maxLength: 240 },
    wallFinish: { type: 'string', minLength: 1, maxLength: 240 },
    ceilingHeightMm: { type: 'integer', minimum: 1800, maximum: 10_000 },
    palette: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 32 }, maxItems: 12 },
    renderStyle: { type: 'string', minLength: 1, maxLength: 240 },
  },
  ['roomId', 'floorMaterial', 'wallFinish', 'ceilingHeightMm', 'palette', 'renderStyle'],
)

export function validateSchema(schema: Schema, input: unknown, path = 'input'): void {
  const type = schema.type
  if (type === 'object') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${path} must be an object.`)
    const record = input as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    for (const required of (schema.required ?? []) as string[])
      if (!(required in record)) throw new Error(`${path}.${required} is required.`)
    if (schema.additionalProperties === false)
      for (const key of Object.keys(record)) if (!(key in properties)) throw new Error(`${path}.${key} is not allowed.`)
    for (const [key, value] of Object.entries(record))
      if (value !== undefined && properties[key]) validateSchema(properties[key], value, `${path}.${key}`)
    return
  }
  if (type === 'array') {
    if (!Array.isArray(input)) throw new Error(`${path} must be an array.`)
    if (typeof schema.minItems === 'number' && input.length < schema.minItems)
      throw new Error(`${path} has too few items.`)
    if (typeof schema.maxItems === 'number' && input.length > schema.maxItems)
      throw new Error(`${path} has too many items.`)
    input.forEach((item, index) => {
      validateSchema(schema.items as Schema, item, `${path}[${index}]`)
    })
    return
  }
  if (type === 'string') {
    if (typeof input !== 'string') throw new Error(`${path} must be a string.`)
    if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(input))
      throw new Error(`${path} is not an accepted value.`)
    if (typeof schema.minLength === 'number' && input.length < schema.minLength)
      throw new Error(`${path} is too short.`)
    if (typeof schema.maxLength === 'number' && input.length > schema.maxLength) throw new Error(`${path} is too long.`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(input))
      throw new Error(`${path} has an invalid format.`)
    return
  }
  if (type === 'integer' && !Number.isInteger(input)) throw new Error(`${path} must be an integer.`)
  if (type === 'number' && (typeof input !== 'number' || !Number.isFinite(input)))
    throw new Error(`${path} must be a finite number.`)
  if ((type === 'integer' || type === 'number') && typeof input === 'number') {
    if (typeof schema.minimum === 'number' && input < schema.minimum) throw new Error(`${path} is below its minimum.`)
    if (typeof schema.maximum === 'number' && input > schema.maximum) throw new Error(`${path} exceeds its maximum.`)
  }
}
