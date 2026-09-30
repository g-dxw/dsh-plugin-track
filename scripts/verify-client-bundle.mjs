import { readFileSync } from 'node:fs'

// These are the only external calls emitted by this plugin's client bundle.
// Both names are seeds in dsh-client-web's PLATFORM_MODULES table.
const allowed = new Set(['react', 'react/jsx-runtime'])
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const required = [...bundle.matchAll(/\brequire\((['"])([^'"\r\n]+)\1\)/g)]
  .map((match) => match[2])
const unsupported = [...new Set(required.filter((name) => !allowed.has(name)))]

if (unsupported.length > 0) {
  throw new Error(`Track client bundle contains unsupported require(): ${unsupported.join(', ')}`)
}

if (required.length === 0) {
  throw new Error('Track client bundle has no external require() calls; check the verifier against the generated format')
}

console.log(`Track client bundle externals verified: ${[...new Set(required)].join(', ')}`)
