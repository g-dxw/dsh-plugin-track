import { readFileSync } from 'node:fs'
import { verifyPackage } from './release-package-utils.mjs'

try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-package.mjs <package.tgz>')
  console.log(JSON.stringify(verifyPackage(readFileSync(process.argv[2]))))
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
}
