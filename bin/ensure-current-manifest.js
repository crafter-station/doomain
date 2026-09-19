import { readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function removeStaleDevelopmentManifest(binUrl) {
  const root = dirname(dirname(fileURLToPath(binUrl)))
  const packagePath = join(root, 'package.json')
  const manifestPath = join(root, 'oclif.manifest.json')
  try {
    const [packageJson, manifest] = await Promise.all([
      readFile(packagePath, 'utf8').then(JSON.parse),
      readFile(manifestPath, 'utf8').then(JSON.parse),
    ])
    if (packageJson.version !== manifest.version) await unlink(manifestPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
