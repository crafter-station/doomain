#!/usr/bin/env node

import { removeStaleDevelopmentManifest } from './ensure-current-manifest.js'

await removeStaleDevelopmentManifest(import.meta.url)
const { execute } = await import('@oclif/core')

const args = process.argv.slice(2)
const routedArgs = args.length === 0 || (args.length === 1 && args[0] === '--json') ? ['wizard', ...args] : args

await execute({ args: routedArgs, dir: import.meta.url })
