// Load environment variables (e.g. OPENROUTER_API_KEY) for tests that hit real
// LLM providers. We parse .env manually to avoid adding a dependency. The mock
// tests don't need this but it's harmless for them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

try {
  const raw = readFileSync(join(here, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // No .env file — real-LLM tests will self-skip if the key is absent.
}
