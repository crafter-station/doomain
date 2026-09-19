import { Command } from '@oclif/core'
import { runDoomainEffect } from '../lib/effect.js'
import { jsonFlag } from '../lib/flags.js'
import { createOutput, outputError } from '../lib/output.js'
import { installLatestVersion } from '../lib/self-update.js'

export default class Update extends Command {
  static description = 'Install the latest doomain version from npm without using the existing npm cache.'

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json']

  static flags = {
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Update)
    const out = createOutput({ json: flags.json })
    const spinner = out.spinner()

    try {
      spinner.start('Downloading the latest doomain version from npm')
      const result = await runDoomainEffect(installLatestVersion())
      spinner.stop('Installed the latest doomain version')
      out.result(result)
      out.success('Installed the latest doomain version from npm.')
    } catch (error) {
      spinner.error('Update failed')
      outputError(out.json, error, 'SELF_UPDATE_FAILED')
      this.exit(1)
    }
  }
}
