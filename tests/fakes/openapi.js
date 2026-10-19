// Validates request bodies against Parqet's official OpenAPI spec without npm packages.
// The spec is downloaded by scripts/fetch-spec.mjs; it belongs to Parqet and is not part of this repo.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const specPath = fileURLToPath(new URL('../../spec/parqet-openapi.json', import.meta.url));
if (!existsSync(specPath)) {
  throw new Error('Parqet OpenAPI spec missing. Run: node scripts/fetch-spec.mjs');
}
export const spec = JSON.parse(readFileSync(specPath, 'utf8'));

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function resolve(schema) {
  let s = schema;
  while (s && s.$ref) {
    const path = s.$ref.replace(/^#\//, '').split('/');
    s = path.reduce((node, key) => node[key], spec);
  }
  return s;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/**
 * Minimal JSON Schema validator for the keywords Parqet's activity schemas use:
 * $ref, oneOf, anyOf, allOf, type, const, enum, pattern, format date-time,
 * minLength, maxLength, minItems, maxItems, minimum, maximum, required, properties, items.
 * Returns a list of error strings; empty means valid.
 */
export function validate(schemaIn, value, path = '$') {
  const s = resolve(schemaIn);
  if (!s || s === true) return [];
  const errors = [];
  const err = (msg) => errors.push(`${path}: ${msg}`);

  if (s.oneOf) {
    const passing = s.oneOf.filter((sub) => validate(sub, value, path).length === 0).length;
    if (passing !== 1) err(`must match exactly one schema in oneOf, matched ${passing}`);
  }
  if (s.anyOf && !s.anyOf.some((sub) => validate(sub, value, path).length === 0)) err('must match a schema in anyOf');
  if (s.allOf) for (const sub of s.allOf) errors.push(...validate(sub, value, path));

  if (s.type) {
    const t = typeOf(value);
    const allowed = Array.isArray(s.type) ? s.type : [s.type];
    const ok = allowed.some((a) => a === t || (a === 'number' && t === 'integer'));
    if (!ok) {
      err(`must be ${allowed.join('|')}, got ${t}`);
      return errors;
    }
  }
  if ('const' in s && value !== s.const) err(`must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) err(`must be one of the enum values, got ${JSON.stringify(value)}`);

  if (typeof value === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(value)) err(`must match ${s.pattern}`);
    if (s.format === 'date-time' && !DATE_TIME.test(value)) err('must be a date-time');
    if (s.minLength !== undefined && value.length < s.minLength) err(`must have at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && value.length > s.maxLength) err(`must have at most ${s.maxLength} characters`);
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) err(`must be >= ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) err(`must be <= ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) err(`must have at least ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) err(`must have at most ${s.maxItems} items`);
    if (s.items) value.forEach((item, i) => errors.push(...validate(s.items, item, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of s.required ?? []) if (!(key in value)) err(`must have property ${key}`);
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`));
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (s.properties ?? {}))) err(`must not have property ${key}`);
    }
  }
  return errors;
}

/** Validator for the POST /portfolios/{id}/activities body, ajv-style: returns boolean, sets .errors. */
export function createActivityBodyValidator() {
  const schema = spec.paths['/portfolios/{portfolioId}/activities'].post.requestBody.content['application/json'].schema;
  const fn = (body) => {
    const errors = validate(schema, body);
    fn.errors = errors.length ? errors : null;
    return errors.length === 0;
  };
  fn.errors = null;
  return fn;
}
