import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const specPath = fileURLToPath(new URL('../../spec/parqet-openapi.json', import.meta.url));
export const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, unknown>>;
};

let cache: ValidateFunction | null = null;

/** Validator for the POST /portfolios/{id}/activities body, straight from Parqet's OpenAPI spec. */
export function createActivityBodyValidator(): ValidateFunction {
  if (cache) return cache;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'parqet', components: spec.components });
  const op = spec.paths['/portfolios/{portfolioId}/activities']!.post as {
    requestBody: { content: { 'application/json': { schema: { $ref: string } } } };
  };
  const ref = op.requestBody.content['application/json'].schema.$ref; // #/components/schemas/...
  cache = ajv.compile({ $ref: `parqet${ref}` });
  return cache;
}
