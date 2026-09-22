// The root workspace package (dsh-root) has no source of its own: it is a
// solution-only package whose tsdown config still declares the classic
// `lib/types/{index,invariant,startup}.js` entry (kept for the Node loader /
// browser artifact contract). The host tsc build is noEmit for the root
// project, so on a clean checkout those entry files do not exist and tsdown
// fails with "Cannot find entry". This script materializes minimal placeholder
// modules so `build:lib:host` works from a clean clone, matching the artifact
// shape the config expects.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'lib', 'types')
mkdirSync(outDir, { recursive: true })
for (const name of ['index', 'invariant', 'startup']) {
  const file = join(outDir, `${name}.js`)
  writeFileSync(file, 'export {}\n')
}
