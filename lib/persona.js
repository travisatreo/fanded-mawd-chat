// MAWD persona loader.
//
// Reads system/mawd-persona.md once at module init (cold start) and
// exposes it as a cacheable system block for Anthropic calls. Callers
// should spread `personaSystemBlock()` into the `system` array of their
// messages.create request so Anthropic caches the large block and only
// re-tokenizes the endpoint-specific context on each call.
//
// Usage:
//   import { personaSystemBlock } from '../lib/persona.js';
//   ...
//   body: JSON.stringify({
//     model: 'claude-opus-4-6',
//     system: [
//       ...personaSystemBlock(),
//       { type: 'text', text: endpointContext } // not cached
//     ],
//     messages: [...]
//   })

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let cachedPersona = null;

function loadPersona() {
  if (cachedPersona !== null) return cachedPersona;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // lib/persona.js -> ../system/mawd-persona.md
    const path = resolve(here, '..', 'system', 'mawd-persona.md');
    cachedPersona = readFileSync(path, 'utf8');
  } catch (err) {
    console.error('[persona] failed to load system/mawd-persona.md:', err.message);
    cachedPersona = ''; // fall back to empty so callers degrade gracefully
  }
  return cachedPersona;
}

// Returns an array of Anthropic system blocks. The first block is the
// persona marked for ephemeral cache (saves tokens after the first call
// in the same 5-minute window). Append endpoint-specific context as
// additional blocks — those should NOT have cache_control.
export function personaSystemBlock() {
  const text = loadPersona();
  if (!text) return []; // persona unavailable, safer to send nothing
  return [
    { type: 'text', text, cache_control: { type: 'ephemeral' } }
  ];
}

// Returns the raw persona string, for integration points that build
// a single concatenated system prompt instead of the blocks array.
export function personaText() {
  return loadPersona();
}
