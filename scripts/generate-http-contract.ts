import { writeFile } from 'node:fs/promises';
import { serializeHttpOpenApi } from '../src/contracts/http-openapi.js';

await writeFile(new URL('../docs/openapi.json', import.meta.url), serializeHttpOpenApi(), 'utf8');
process.stdout.write('Generated docs/openapi.json from src/contracts/http-openapi.ts\n');
