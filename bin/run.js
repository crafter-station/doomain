#!/usr/bin/env node

import {execute} from '@oclif/core'

const args = process.argv.slice(2)
const routedArgs = args.length === 0 || (args.length === 1 && args[0] === '--json') ? ['wizard', ...args] : args

await execute({args: routedArgs, dir: import.meta.url})
