import {DmlinkError} from './errors.js'

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export interface DomainTarget {
  zoneDomain: string
  fullDomain: string
  recordName: string
  isApex: boolean
}

export function normalizeDomain(input: string): string {
  const value = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  const domain = value.split('/')[0]

  if (!domain || domain.length > 253) {
    throw new DmlinkError('INVALID_INPUT', 'Domain is required.')
  }

  const labels = domain.split('.')
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new DmlinkError('INVALID_INPUT', `Invalid domain: ${input}`)
  }

  return domain
}

export function normalizeSubdomain(input: string): string {
  const subdomain = input.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
  if (!subdomain || subdomain === '@') {
    throw new DmlinkError('INVALID_INPUT', 'Subdomain is required unless --apex is used.')
  }

  const labels = subdomain.split('.')
  if (labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new DmlinkError('INVALID_INPUT', `Invalid subdomain: ${input}`)
  }

  return subdomain
}

export function resolveDomainTarget(opts: {domain: string; subdomain?: string; apex?: boolean}): DomainTarget {
  const zoneDomain = normalizeDomain(opts.domain)

  if (opts.apex) {
    if (opts.subdomain) {
      throw new DmlinkError('INVALID_INPUT', 'Use either --apex or --subdomain, not both.')
    }

    return {
      zoneDomain,
      fullDomain: zoneDomain,
      recordName: '@',
      isApex: true,
    }
  }

  if (!opts.subdomain) {
    throw new DmlinkError('MISSING_ARGUMENT', 'Provide --subdomain or use --apex.')
  }

  const subdomain = normalizeSubdomain(opts.subdomain)

  return {
    zoneDomain,
    fullDomain: `${subdomain}.${zoneDomain}`,
    recordName: subdomain,
    isApex: false,
  }
}

export function ensureProviderId(value: string): string {
  const provider = value.trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) {
    throw new DmlinkError('INVALID_INPUT', `Invalid provider id: ${value}`)
  }

  return provider
}

export function ensureProject(value?: string): string {
  const project = value?.trim()
  if (!project) throw new DmlinkError('MISSING_ARGUMENT', 'Vercel project is required.')
  return project
}
