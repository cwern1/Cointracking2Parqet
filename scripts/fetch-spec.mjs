// Downloads Parqet's OpenAPI spec for the schema tests. The spec belongs to Parqet and is not part of this repo.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const target = new URL('../spec/parqet-openapi.json', import.meta.url);
const force = process.argv.includes('--force');

if (existsSync(target) && !force) process.exit(0);
const res = await fetch('https://developer.parqet.com/api-spec/current.json');
if (!res.ok) {
  console.error(`Could not download the Parqet OpenAPI spec: HTTP ${res.status}`);
  process.exit(1);
}
mkdirSync(new URL('../spec/', import.meta.url), { recursive: true });
writeFileSync(target, JSON.stringify(await res.json(), null, 1));
console.log('Downloaded spec/parqet-openapi.json');
