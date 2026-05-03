import {Command} from '@oclif/core'
import * as p from '@clack/prompts'

import {loadConfig, maskSecret, updateConfig} from '../lib/config.js'
import {DoomainError} from '../lib/errors.js'
import {jsonFlag} from '../lib/flags.js'
import {createLinkPlan, linkDomain} from '../lib/link-domain.js'
import {detectLocalVercelProject} from '../lib/local-vercel.js'
import {createOutput, outputError} from '../lib/output.js'
import {
  DEFAULT_PROVIDER_ACCOUNT,
  isDefaultProviderAccount,
  listConfiguredProviderAccounts,
  normalizeProviderAccount,
  providerAccountHasCredentials,
  type ProviderAccountRef,
  withProviderAccountCredentials,
} from '../lib/providers/core/config.js'
import {createProvider, getProviderDefinition, listProviderDefinitions} from '../lib/providers/registry.js'
import type {CredentialDefinition, DnsProviderDefinition, DnsRecordInput, DnsZone} from '../lib/providers/types.js'
import {listGlobalVercelTokens, type GlobalVercelToken} from '../lib/vercel-auth.js'
import {createVercelClient, type VercelTeam} from '../lib/vercel.js'

const PERSONAL_ACCOUNT = '__personal__'
const NEW_TOKEN = '__new_token__'

function cancelIfNeeded<T>(value: T | symbol): T | null {
  if (p.isCancel(value)) {
    p.cancel('Cancelled')
    return null
  }

  return value
}

async function promptRequired(message: string, opts: {password?: boolean; placeholder?: string} = {}): Promise<string | null> {
  const value = opts.password
    ? await p.password({message})
    : await p.text({message, placeholder: opts.placeholder, validate: (input) => (input?.trim() ? undefined : 'Required')})
  const resolved = cancelIfNeeded(value)
  return typeof resolved === 'string' ? resolved.trim() : null
}

function validateProviderAccount(value: string | undefined): string | undefined {
  try {
    normalizeProviderAccount(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function promptProviderAccount(): Promise<string | null> {
  const value = await p.text({message: 'Profile name', placeholder: DEFAULT_PROVIDER_ACCOUNT, validate: validateProviderAccount})
  const resolved = cancelIfNeeded(value)
  return typeof resolved === 'string' ? normalizeProviderAccount(resolved) : null
}

async function confirmProviderAccountOverwrite(definition: DnsProviderDefinition, account: string): Promise<boolean> {
  const value = await p.confirm({
    initialValue: false,
    message: `Profile "${account}" already exists for ${definition.displayName}. Overwrite it?`,
  })
  const resolved = cancelIfNeeded(value)
  return resolved === true
}

interface ProviderDomainOption {
  account: string
  domain: string
  id: string
  isDefaultAccount: boolean
  providerId: string
  providerName: string
}

async function fetchPublicIp(): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2000)

  try {
    const response = await fetch('https://api.ipify.org', {signal: controller.signal})
    if (!response.ok) return undefined
    const ip = (await response.text()).trim()
    return ip || undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

async function credentialInitialValue(credential: CredentialDefinition): Promise<string | undefined> {
  if (credential.key !== 'clientIp') return undefined
  return fetchPublicIp()
}

async function promptCredential(credential: CredentialDefinition): Promise<string | null> {
  const initialValue = credential.secret ? undefined : await credentialInitialValue(credential)
  const value = credential.secret
    ? await p.password({message: credential.label})
    : await p.text({message: credential.label, initialValue, placeholder: credential.placeholder ?? credential.hint})
  const resolved = cancelIfNeeded(value)
  return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : null
}

async function promptProviderCredentials(definition: DnsProviderDefinition): Promise<Record<string, string> | null> {
  const credentials: Record<string, string> = {}

  for (const credential of definition.credentials) {
    if (credential.required === false) continue
    const value = await promptCredential(credential)
    if (!value) return null
    credentials[credential.key] = value
  }

  return credentials
}

async function promptProviderDefinition(
  definitions: DnsProviderDefinition[],
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<DnsProviderDefinition | null> {
  const selected = await p.select({
    message: 'Choose DNS provider',
    options: definitions.map((definition) => ({
      hint: listConfiguredProviderAccounts(config, definition).length > 0 ? 'Connected' : 'Not connected',
      label: definition.displayName,
      value: definition.id,
    })),
  })
  const selectedId = cancelIfNeeded(selected)
  if (selectedId === null) return null
  return getProviderDefinition(selectedId)
}

function showProviderSetup(definition: DnsProviderDefinition): void {
  if (!definition.setup?.notes?.length) return
  p.note(definition.setup.notes.join('\n'), `${definition.displayName} setup`)
}

async function listProviderDomainOptions(definition: DnsProviderDefinition, account: ProviderAccountRef): Promise<ProviderDomainOption[]> {
  const provider = await createProvider(definition.id, {account: account.account})
  const zones = await provider.listZones()
  return zones.map((zone) => toProviderDomainOption(definition, account, zone))
}

function toProviderDomainOption(definition: DnsProviderDefinition, account: ProviderAccountRef, zone: DnsZone): ProviderDomainOption {
  return {
    account: account.account,
    domain: zone.name,
    id: `${definition.id}:${account.account}:${zone.name}`,
    isDefaultAccount: account.isDefaultAccount,
    providerId: definition.id,
    providerName: definition.displayName,
  }
}

function providerAccountLabel(option: Pick<ProviderDomainOption, 'account' | 'isDefaultAccount' | 'providerName'>): string {
  return option.isDefaultAccount ? option.providerName : `${option.providerName}/${option.account}`
}

function projectLabel(project: {id: string; name?: string}): string {
  return project.name ? `${project.name} (${project.id})` : project.id
}

function teamLabel(team: VercelTeam): string {
  const name = team.name ?? team.slug
  return `${name} (${team.id})`
}

function globalTokenLabel(token: GlobalVercelToken): string {
  return token.source === 'environment' ? `Use ${token.label}` : `Use ${token.label} token`
}

function isVercelAuthError(error: unknown): boolean {
  return error instanceof DoomainError && error.code === 'VERCEL_AUTH_FAILED'
}

async function promptVercelToken(globalTokens: GlobalVercelToken[]): Promise<string | null> {
  if (globalTokens.length > 0) {
    const selected = await p.select({
      message: 'Vercel token',
      options: [
        ...globalTokens.map((token, index) => ({label: globalTokenLabel(token), value: String(index), hint: maskSecret(token.token)})),
        {label: 'Enter a new token', value: NEW_TOKEN},
      ],
    })

    const resolved = cancelIfNeeded(selected)
    if (resolved === null) return null
    if (resolved !== NEW_TOKEN) return globalTokens[Number(resolved)]?.token ?? null
  }

  return promptRequired('Vercel token', {password: true})
}

function recordPreview(record: DnsRecordInput, providerName: string): string {
  const name = record.name === '@' ? 'root' : record.name
  return `DNS: ${record.type} ${name} -> ${record.value} in ${providerName}`
}

export default class Wizard extends Command {
  static description = 'Interactive Vercel domain linker.'

  static hidden = true

  static flags = {
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Wizard)
    const out = createOutput({json: flags.json})
    let activeSpinner: ReturnType<typeof p.spinner> | undefined

    if (out.json) {
      outputError(
        true,
        new DoomainError('MISSING_ARGUMENT', 'The root `doomain` command is interactive. Use `doomain link --json` for agents.'),
        'MISSING_ARGUMENT',
      )
      this.exit(1)
    }

    try {
      p.intro('Doomain')
      const config = await loadConfig()
      const providerDefinitions = listProviderDefinitions()
      const localProject = detectLocalVercelProject()
      let vercelToken = config.vercel?.token
      let vercelTeamId = process.env.VERCEL_TEAM_ID || localProject?.orgId || config.vercel?.teamId
      const defaultProvider = process.env.DOOMAIN_PROVIDER || config.defaults?.provider
      const defaultDomain = process.env.DOOMAIN_DOMAIN || config.defaults?.domain
      let globalVercelTokens: GlobalVercelToken[] = []

      if (!vercelToken) {
        globalVercelTokens = await listGlobalVercelTokens()
        vercelToken = (await promptVercelToken(globalVercelTokens)) ?? undefined
        if (!vercelToken) return
      }

      let teams: VercelTeam[] = []

      while (true) {
        const teamSpinner = p.spinner()
        try {
          if (process.env.VERCEL_TEAM_ID) {
            p.log.info(`Using Vercel team ${vercelTeamId} from VERCEL_TEAM_ID.`)
          } else {
            activeSpinner = teamSpinner
            teamSpinner.start('Loading Vercel teams')
            teams = await createVercelClient({token: vercelToken}).listTeams()
            teamSpinner.stop(`Loaded ${teams.length} Vercel team${teams.length === 1 ? '' : 's'}`)
            activeSpinner = undefined

            const selected = await p.select({
              message: 'Select Vercel account/team',
              initialValue: vercelTeamId ?? localProject?.orgId ?? PERSONAL_ACCOUNT,
              options: [
                {label: 'Personal account', value: PERSONAL_ACCOUNT, hint: 'No team id'},
                ...teams.map((team) => ({label: teamLabel(team), value: team.id, hint: team.role ?? team.slug})),
              ],
            })
            const resolved = cancelIfNeeded(selected)
            if (resolved === null) return
            vercelTeamId = resolved === PERSONAL_ACCOUNT ? undefined : resolved
          }
          break
        } catch (error) {
          if (!isVercelAuthError(error) || process.env.VERCEL_TOKEN) throw error
          activeSpinner?.error('Vercel authorization failed')
          activeSpinner = undefined
          p.log.warning(error instanceof Error ? error.message : String(error))
          if (globalVercelTokens.length === 0) globalVercelTokens = await listGlobalVercelTokens()
          globalVercelTokens = globalVercelTokens.filter((token) => token.token !== vercelToken)
          vercelToken = (await promptVercelToken(globalVercelTokens)) ?? undefined
          if (!vercelToken) return
        }
      }

      const selectedTeam = teams.find((team) => team.id === vercelTeamId)
      const teamDisplay = vercelTeamId ? teamLabel(selectedTeam ?? {id: vercelTeamId, name: null, role: null, slug: vercelTeamId}) : 'Personal account'
      p.log.success(`Vercel account ready: ${teamDisplay}`)

      const projectSpinner = p.spinner()
      activeSpinner = projectSpinner
      projectSpinner.start('Loading Vercel projects')
      const projects = await createVercelClient({token: vercelToken, teamId: vercelTeamId}).listProjects()
      projectSpinner.stop(`Loaded ${projects.length} projects`)
      activeSpinner = undefined

      if (projects.length === 0) {
        throw new DoomainError('PROJECT_NOT_FOUND', `No Vercel projects found in ${teamDisplay}.`)
      }

      const localProjectMatchesTeam = localProject && (vercelTeamId ? localProject.orgId === vercelTeamId : !localProject.orgId)
      const initialProject = localProjectMatchesTeam && projects.some((item) => item.id === localProject.projectId) ? localProject.projectId : undefined
      const selected = await p.autocomplete({
        message: 'Select Vercel project',
        placeholder: 'Type to filter projects...',
        maxItems: 10,
        initialValue: initialProject,
        options: projects.map((item) => ({
          label: projectLabel(item),
          value: item.id,
          hint: item.id === initialProject ? 'linked in .vercel' : (item.framework ?? undefined),
        })),
      })
      const resolved = cancelIfNeeded(selected)
      if (resolved === null) return
      const project = resolved
      const projectDisplay = projectLabel(projects.find((item) => item.id === project) ?? {id: project})

      p.log.success(`Vercel ready: ${projectDisplay}`)

      const configuredProviderAccounts = providerDefinitions.flatMap((definition) =>
        listConfiguredProviderAccounts(config, definition).map((account) => ({account, definition})),
      )
      const providerFailures: string[] = []
      const domainOptions: ProviderDomainOption[] = []

      if (configuredProviderAccounts.length === 0) {
        p.log.info('No DNS provider is configured yet. Connect one to continue.')
        const selectedDefinition = await promptProviderDefinition(providerDefinitions, config)
        if (!selectedDefinition) return
        showProviderSetup(selectedDefinition)
        const account = await promptProviderAccount()
        if (!account) return
        if (providerAccountHasCredentials(config, selectedDefinition.id, account)) {
          const overwrite = await confirmProviderAccountOverwrite(selectedDefinition, account)
          if (!overwrite) return
        }

        const providerAccount = {account, isDefaultAccount: isDefaultProviderAccount(account), providerId: selectedDefinition.id}
        const credentials = await promptProviderCredentials(selectedDefinition)
        if (!credentials) return

        const domainSpinner = p.spinner()
        activeSpinner = domainSpinner
        domainSpinner.start(`Verifying ${selectedDefinition.displayName} credentials and loading domains`)
        const provider = selectedDefinition.create({credentials, debug: process.env.DOOMAIN_DEBUG === '1'})
        const zones = await provider.listZones()
        domainSpinner.stop(
          `Connected ${selectedDefinition.displayName} and loaded ${zones.length} domain${zones.length === 1 ? '' : 's'}`,
        )
        activeSpinner = undefined
        domainOptions.push(
          ...zones.map((zone) => toProviderDomainOption(selectedDefinition, providerAccount, zone)),
        )

        await updateConfig((current) => ({
          ...current,
          defaults: {...current.defaults, provider: selectedDefinition.id},
          providers: {
            ...current.providers,
            [selectedDefinition.id]: withProviderAccountCredentials(current.providers?.[selectedDefinition.id], account, credentials),
          },
          vercel: {token: vercelToken, teamId: vercelTeamId},
        }))
      } else {
        const domainSpinner = p.spinner()
        activeSpinner = domainSpinner
        domainSpinner.start(
          `Loading domains from ${configuredProviderAccounts.length} provider account${configuredProviderAccounts.length === 1 ? '' : 's'}`,
        )

        for (const {account, definition} of configuredProviderAccounts) {
          try {
            domainOptions.push(...(await listProviderDomainOptions(definition, account)))
          } catch (error) {
            const label = account.isDefaultAccount ? definition.displayName : `${definition.displayName}/${account.account}`
            providerFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        domainSpinner.stop(`Loaded ${domainOptions.length} domain${domainOptions.length === 1 ? '' : 's'}`)
        activeSpinner = undefined
        for (const failure of providerFailures) p.log.warning(failure)

        await updateConfig((current) => ({
          ...current,
          vercel: {token: vercelToken, teamId: vercelTeamId},
        }))
      }

      if (domainOptions.length === 0) {
        throw new DoomainError(
          'CONFIG_NOT_FOUND',
          'No domains found in configured DNS providers. Verify provider credentials and domain permissions.',
        )
      }

      const providerNames = [...new Set(domainOptions.map((option) => option.providerName))].join(', ')
      p.log.success(`DNS ready: ${providerNames} (${domainOptions.length} domains)`)

      let selectedDomain = domainOptions[0]

      if (domainOptions.length > 1) {
        const initialValue =
          domainOptions.find((option) => option.providerId === defaultProvider && option.domain === defaultDomain)?.id ??
          domainOptions.find((option) => option.domain === defaultDomain)?.id
        const selectedDomainId = await p.autocomplete({
          message: 'Select domain',
          placeholder: 'Type to filter domains...',
          maxItems: 10,
          initialValue,
          options: domainOptions.map((option) => ({label: option.domain, value: option.id, hint: providerAccountLabel(option)})),
        })
        const selectedId = cancelIfNeeded(selectedDomainId)
        if (selectedId === null) return
        selectedDomain = domainOptions.find((option) => option.id === selectedId) ?? domainOptions[0]
      }

      p.log.info(`Using domain ${selectedDomain.domain} from ${providerAccountLabel(selectedDomain)}.`)

      const domain = selectedDomain.domain

      await updateConfig((current) => ({
        ...current,
        defaults: {...current.defaults, domain, provider: selectedDomain.providerId},
      }))

      const mode = await p.select({
        message: 'What should Doomain add?',
        options: [
          {label: `Subdomain under ${domain}`, value: 'subdomain'},
          {label: `Root domain (${domain})`, value: 'apex'},
        ],
      })
      const resolvedMode = cancelIfNeeded(mode)
      if (resolvedMode === null) return

      let subdomain: string | undefined
      const apex = resolvedMode === 'apex'
      if (!apex) {
        subdomain = (await promptRequired('Subdomain', {placeholder: 'app'})) ?? undefined
        if (!subdomain) return
      }

      const fullDomain = apex ? domain : `${subdomain}.${domain}`
      const preview = await createLinkPlan({account: selectedDomain.account, provider: selectedDomain.providerId, domain, subdomain, apex, project})
      p.note(
        [`Vercel: add ${preview.domain} to ${projectDisplay}`, ...preview.records.map((record) => recordPreview(record, providerAccountLabel(selectedDomain)))].join(
          '\n',
        ),
        'Preview',
      )
      const confirmed = await p.confirm({
        message: `Link ${fullDomain} via ${selectedDomain.providerName} to Vercel project ${projectDisplay}?`,
        initialValue: true,
      })
      const shouldContinue = cancelIfNeeded(confirmed)
      if (!shouldContinue) return

      const spinner = p.spinner()
      activeSpinner = spinner
      spinner.start('Adding domain to Vercel')
      const result = await linkDomain({
        account: selectedDomain.account,
        provider: selectedDomain.providerId,
        domain,
        subdomain,
        apex,
        project,
        progress: ({message}) => spinner.message(message),
        wait: true,
      })
      spinner.stop(result.vercel.verified ? 'Domain linked and verified' : 'Domain linked')
      activeSpinner = undefined

      p.outro(
        result.vercel.verified
          ? `${result.domain} is linked to ${projectDisplay}. SSL certificate provisioning may take a few minutes in Vercel.`
          : `${result.domain} is linked to ${projectDisplay}.`,
      )
    } catch (error) {
      activeSpinner?.error('Operation failed')
      outputError(false, error, 'DOMAIN_LINK_FAILED')
      this.exit(1)
    }
  }
}
