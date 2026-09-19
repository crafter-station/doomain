#!/usr/bin/env -S node --loader ts-node/esm --disable-warning=ExperimentalWarning

import { removeStaleDevelopmentManifest } from './ensure-current-manifest.js'

await removeStaleDevelopmentManifest(import.meta.url)
const { execute } = await import('@oclif/core')
await execute({ development: true, dir: import.meta.url })
