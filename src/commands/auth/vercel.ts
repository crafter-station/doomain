import * as p from '@clack/prompts'
import { Command, Flags } from '@oclif/core'

import { getConfigPath, maskSecret, updateConfig } from '../../lib/config.js'
import { runDoomainEffect } from '../../lib/effect.js'
import { jsonFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'
import { createVercelClient, type VercelTeam } from '../../lib/vercel.js'
import { type GlobalVercelToken, listGlobalVercelTokens } from '../../lib/vercel-auth.js'

const PERSONAL_ACCOUNT = '__personal__'
const NEW_TOKEN = '__new_token__'

function assertValue(value: unknown, message: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(message)
}

function teamLabel(team: VercelTeam): string {
  const name = team.name ?? team.slug
  return `${name} (${team.id})`
}

function globalTokenLabel(token: GlobalVercelToken): string {
  return token.source === 'environment' ? `Use ${token.label}` : `Use ${token.label} token`
}

async function promptVercelToken(globalTokens: GlobalVercelToken[]): Promise<string | null> {
  if (globalTokens.length > 0) {
    const selected = await p.select({
      message: 'Vercel token',
      options: [
        ...globalTokens.map((token, index) => ({
          label: globalTokenLabel(token),
          value: String(index),
          hint: maskSecret(token.token),
        })),
        { label: 'Enter a new token', value: NEW_TOKEN },
      ],
    })

    if (p.isCancel(selected)) {
      p.cancel('Cancelled')
      return null
    }

    if (selected !== NEW_TOKEN) return globalTokens[Number(selected)]?.token ?? null
  }

  const value = await p.password({ message: 'Vercel token' })
  if (p.isCancel(value)) {
    p.cancel('Cancelled')
    return null
  }

  return value
}

export default class AuthVercel extends Command {
  static description = 'Save Vercel credentials locally.'

  static flags = {
    json: jsonFlag,
    'team-id': Flags.string({
      description: 'Vercel team id. Interactive mode can fetch and select this from your token.',
    }),
    token: Flags.string({ description: 'Vercel API token.' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthVercel)
    const out = createOutput({ json: flags.json })

    try {
      let token = flags.token
      let teamId = flags['team-id'] || process.env.VERCEL_TEAM_ID?.trim() || undefined
      const globalTokens = token ? [] : await runDoomainEffect(listGlobalVercelTokens())

      if (!token) {
        if (out.json) {
          token = globalTokens[0]?.token
        } else {
          token = (await promptVercelToken(globalTokens)) ?? undefined
          if (!token) return
        }
      }

      token = assertValue(token, 'Missing Vercel token. Pass --token, set VERCEL_TOKEN, or sign in with Vercel CLI.')

      if (!out.json && teamId === undefined) {
        const spinner = p.spinner()
        spinner.start('Loading Vercel teams')
        const teams = await runDoomainEffect(createVercelClient({ token }).listTeams())
        spinner.stop(`Loaded ${teams.length} Vercel team${teams.length === 1 ? '' : 's'}`)

        const selected = await p.select({
          message: 'Select Vercel account/team',
          options: [
            { label: 'Personal account', value: PERSONAL_ACCOUNT, hint: 'No team id' },
            ...teams.map((team) => ({ label: teamLabel(team), value: team.id, hint: team.role ?? team.slug })),
          ],
        })

        if (p.isCancel(selected)) {
          p.cancel('Cancelled')
          return
        }

        teamId = selected === PERSONAL_ACCOUNT ? undefined : selected
      }

      await runDoomainEffect(
        updateConfig((config) => ({
          ...config,
          vercel: { token, teamId },
        })),
      )

      out.result({ configPath: getConfigPath(), vercel: { token: maskSecret(token), teamId } })
      out.success(`Vercel credentials saved to ${getConfigPath()}.`)
    } catch (error) {
      outputError(out.json, error, 'MISSING_CREDENTIALS')
      this.exit(1)
    }
  }
}
