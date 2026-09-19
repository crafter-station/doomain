import { Command } from '@oclif/core'

export default class Version extends Command {
  static description = 'Display the installed doomain version.'

  async run(): Promise<void> {
    await this.parse(Version)
    this.log(this.config.userAgent)
  }
}
