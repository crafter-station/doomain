#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(await readFile(new URL('../oclif.manifest.json', import.meta.url), 'utf8'))

if (packageJson.version !== manifest.version) {
  console.error(
    `oclif manifest version mismatch: package.json=${packageJson.version} oclif.manifest.json=${manifest.version}`,
  )
  process.exitCode = 1
}
