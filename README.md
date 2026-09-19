# Doomain

Doomain points DNS records and links Vercel projects or first-time Clerk production instances to custom domains from your terminal.

It handles the boring parts of custom-domain setup: selecting the Vercel project, finding the right DNS zone, adding the domain to Vercel, writing the Vercel DNS records, waiting for public DNS propagation, and asking Vercel to verify the domain.

Use the interactive wizard when working by hand. Use explicit commands with `--json` for scripts, CI, or agents.

## Features

- Interactive Vercel domain-linking wizard.
- Script-friendly commands with one JSON object on stdout.
- Vercel project detection from `.vercel/project.json`.
- DNS provider inference by longest matching configured zone.
- Generic DNS pointing for VPS, load balancer, and canonical-hostname targets.
- Exact-match DNS removal with dry-run and post-delete verification.
- DNS diagnosis across provider, system/VPN, Cloudflare, and Google views.
- Dry-run plans before writing changes.
- Safety checks before replacing DNS records that point elsewhere.
- DNS propagation and Vercel verification wait loop.
- DNS provider support for Spaceship, Namecheap, Cloudflare, and Hostinger.
- First-time Clerk production setup with automatic CNAME configuration.

## Install

```bash
npm install -g doomain
```

Doomain requires Node.js 18 or newer.

## Quick Start

Run the wizard:

```bash
doomain
```

The wizard will:

1. Ask for a Vercel token if one is not already configured.
2. Let you choose a Vercel personal account or team.
3. Detect and preselect a local Vercel project when `.vercel/project.json` exists.
4. Connect a DNS provider if none is configured.
5. List domains from configured DNS providers.
6. Preview the Vercel and DNS changes.
7. Warn if the current DNS target points elsewhere and ask before overriding it.
8. Apply the changes and request Vercel verification.

If you already know the target project and domain, run the link command directly:

```bash
doomain link app.example.com --project my-vercel-project
```

## Scripted Setup

For CI, shell scripts, and agents, use explicit commands and `--json`.

First save Vercel credentials:

```bash
doomain auth vercel \
  --token "$VERCEL_TOKEN" \
  --team-id "$VERCEL_TEAM_ID" \
  --json
```

`--team-id` is optional for personal-account usage.

Then connect one DNS provider:

```bash
doomain providers connect cloudflare \
  --credential apiToken="$CLOUDFLARE_API_TOKEN" \
  --credential accountId="$CLOUDFLARE_ACCOUNT_ID" \
  --json
```

Preview the domain link:

```bash
doomain link app.example.com --project my-vercel-project --dry-run --json
```

Apply it:

```bash
doomain link app.example.com --project my-vercel-project --json
```

Point a domain at non-Vercel infrastructure such as a VPS:

```bash
doomain dns point app.example.com --target 203.0.113.10 --json
```

Set up a Clerk application's first production instance and primary domain:

```bash
doomain auth clerk --platform-api-key "$CLERK_PLATFORM_API_KEY" --app app_123 --json
doomain clerk domains add example.com --app app_123 --json
```

Create a Platform API key from the Clerk Dashboard API keys page. Platform keys start with `ak_`; Clerk instance secret keys (`sk_`) cannot create a production instance.

This Clerk command intentionally aborts when the application already has a production instance. Change existing production domains manually in the Clerk Dashboard or with Clerk CLI.

If JSON mode returns `DNS_TARGET_CONFLICT`, the current DNS target appears to point to another project or site. Re-run with `--force` only when you intend to replace that DNS target.

## Provider Setup

Doomain stores local credentials in `~/.doomain/config.json` with `0600` file permissions. Environment variables override saved config values.

| Provider | Provider ID | Required credentials | Environment variables | Notes |
| --- | --- | --- | --- | --- |
| Spaceship | `spaceship` | `apiKey`, `apiSecret` | `SPACESHIP_API_KEY`, `SPACESHIP_API_SECRET` | API key needs domain read access and DNS record read/write access. |
| Namecheap | `namecheap` | `apiUser`, `apiKey`, `clientIp` | `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_CLIENT_IP` | API access must be enabled and `clientIp` must be your whitelisted public IPv4. Optional: `username`, `sandbox`. |
| Cloudflare | `cloudflare` | `apiToken`, `accountId` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | API token needs `Zone:Read` and `DNS:Edit`. Vercel records are written as DNS-only records, not proxied. |
| Hostinger | `hostinger` | `apiToken` | `HOSTINGER_API_TOKEN` | API token needs access to domain portfolio and DNS zone records. |

### Spaceship

```bash
doomain providers connect spaceship \
  --credential apiKey=spaceship_key \
  --credential apiSecret=spaceship_secret
```

Compatibility aliases are also available:

```bash
doomain providers connect spaceship --api-key spaceship_key --api-secret spaceship_secret
```

### Namecheap

```bash
doomain providers connect namecheap \
  --credential apiUser=your_namecheap_user \
  --credential apiKey=your_api_key \
  --credential clientIp=your_whitelisted_ipv4
```

For Namecheap sandbox testing:

```bash
doomain providers connect namecheap \
  --credential apiUser=your_sandbox_user \
  --credential apiKey=your_sandbox_key \
  --credential clientIp=your_whitelisted_ipv4 \
  --credential sandbox=true
```

`NAMECHEAP_USERNAME` is optional. If omitted, Doomain uses `apiUser` as the Namecheap username.

### Cloudflare

```bash
doomain providers connect cloudflare \
  --credential apiToken=your_cloudflare_api_token \
  --credential accountId=your_cloudflare_account_id
```

Cloudflare `A`, `AAAA`, and `CNAME` records created by Doomain are set to `proxied: false` so targets remain directly verifiable.

### Hostinger

```bash
doomain providers connect hostinger \
  --credential apiToken=your_hostinger_api_token
```

Create Hostinger API tokens from hPanel Account > API. Doomain lists active zones from the Hostinger domain portfolio and updates records through the DNS zone API.

## Linking Domains

You can pass the full target domain as a positional argument:

```bash
doomain link app.example.com --project my-app
```

Or pass a base domain and subdomain:

```bash
doomain link --domain example.com --subdomain app --project my-app
```

Link the apex/root domain:

```bash
doomain link --domain example.com --apex --project my-app
```

An exact zone match without `--subdomain` is also treated as apex:

```bash
doomain link example.com --project my-app
```

Preview without writing to Vercel or DNS:

```bash
doomain link app.example.com --project my-app --dry-run --json
```

Skip the DNS/Vercel verification wait:

```bash
doomain link app.example.com --project my-app --no-wait
```

Change the wait timeout, in seconds:

```bash
doomain link app.example.com --project my-app --timeout 600
```

Use a specific DNS provider instead of provider inference:

```bash
doomain link app.example.com --project my-app --provider cloudflare
```

Use `-p` as shorthand for `--project`:

```bash
doomain link app.example.com -p my-app
```

## Pointing DNS At A VPS Or Hostname

Use `dns point` when Doomain should only reconcile DNS, without adding the domain to Vercel or Clerk. It infers the configured provider account and longest matching zone in the same way as `link`.

Point an apex or subdomain at an IPv4 or IPv6 address:

```bash
doomain dns point example.com --target 203.0.113.10
doomain dns point app.example.com --target 2001:db8::10
```

Point a subdomain at a canonical hostname:

```bash
doomain dns point app.example.com --target origin.example.net
```

The record type is inferred as `A`, `AAAA`, or `CNAME`. Use `--type` to require a specific type, `--ttl` to change the default 300-second TTL, and `--provider`/`--account` to override provider inference.

Canonical hostname targets use CNAME records. Doomain rejects an apex CNAME when the selected provider does not advertise apex-CNAME support; use an IPv4 or IPv6 target for that apex instead.

Preview without writing:

```bash
doomain dns point app.example.com --target 203.0.113.10 --dry-run --json
```

The preview resolves the provider, account, zone, record name, type, and value without reading or writing current DNS records. Conflicts are checked when a real write is attempted.

Every real write is re-read from the provider. Success is returned only when `reconciled: true` and the non-TXT slot contains only the desired record. If an eventually consistent provider does not reach that postcondition, the command fails with `DNS_RECONCILIATION_INCOMPLETE` and includes the observed records; do not treat accepted API requests as a completed cutover.

By default, a successful write waits up to 300 seconds and compares the system resolver with Cloudflare and Google public DNS. Use `--no-wait` to skip resolver verification or `--timeout <seconds>` to change the limit. The JSON `propagation` object includes each resolver's answers, TTLs, expected target, elapsed time, status, and timeout reason. Node's resolver API does not expose CNAME TTLs, so those answers use `ttl: null` with `ttlUnavailableReason` instead of silently omitting the field.

- `propagated`: public and system DNS match.
- `local_or_vpn_cache_stale`: public DNS matches but the system/VPN resolver still serves cached data. The mutation is deployed, and `propagated` is `true`.
- `system_resolver_unavailable`: public DNS matches, but the system resolver query failed. Public propagation is complete, and the resolver error is preserved for diagnosis.
- `public_propagation_pending`: public DNS did not match before the timeout. The reconciled provider mutation succeeded, but `propagated` is `false`; this remains an exit-code-0 partial verification result.
- `not_checked`: resolver verification was skipped or this was a dry run.

Existing exact records are skipped. Conflicting records fail with `DNS_TARGET_CONFLICT` in JSON/non-interactive mode. Use `--force` only after approving replacement of the existing target.

## Removing And Diagnosing DNS Records

Removal defaults to an exact name/type/value match and verifies the record is absent after deletion:

```bash
doomain dns remove app.example.com --type A --value 203.0.113.10 --dry-run --json
doomain dns remove app.example.com --type A --value 203.0.113.10 --json
```

`dns delete` is an alias. If more than one record matches, non-interactive mode fails with `DNS_DELETE_AMBIGUOUS`. Pass `--all-matching` only after reviewing the dry-run plan; interactive mode asks before deleting multiple records.

Use the read-only diagnosis command to compare provider control-plane records with system/VPN and public DNS answers:

```bash
doomain dns diagnose example.com --json
doomain dns diagnose app.example.com --type A --target 203.0.113.10 --json
```

Diagnosis reports record conflicts, answer TTLs, resolver addresses, active interface names, scoped macOS resolver/interface metadata when available, and one of `provider_not_updated`, `public_propagation_pending`, `local_or_vpn_cache_stale`, `system_resolver_unavailable`, or `consistent`.

## Clerk Production Domains

`doomain clerk domains add` mirrors Clerk CLI's initial production deployment API. It creates a production instance by cloning the application's development instance, sets the requested primary domain, writes every CNAME returned by Clerk, and optionally waits for Clerk's DNS, SSL, and email DNS status.

```bash
doomain clerk domains add example.com --app app_123
```

Use `--dry-run` to verify that the application has no production instance and that Doomain can resolve the DNS zone. Clerk only returns the exact CNAME records after production is created, so they are not included in the dry-run result.

If a production instance already exists, the command returns `CLERK_PRODUCTION_EXISTS` without changing DNS. Doomain does not automate production-domain migrations because Clerk domain changes can cause downtime and require publishable-key, OAuth redirect, and deployment updates.

After creation, the result includes Clerk CLI follow-up commands. Run them to link the local project, pull production keys, finish production OAuth configuration, and verify provisioning:

```bash
clerk link --app app_123
clerk env pull --app app_123 --instance prod
clerk deploy
clerk deploy status
```

## What Gets Created

For apex/root domains, Doomain creates Vercel's apex `A` record:

```text
A @ 76.76.21.21
```

For subdomains, Doomain creates a `CNAME` to Vercel's recommended target. If Vercel does not return a special target, it uses:

```text
CNAME app cname.vercel-dns.com
```

During real linking, Doomain also reads Vercel's domain response and adds any required TXT verification records, for example:

```text
TXT _vercel vc-domain-verify=app.example.com,...
```

## Project Detection

`--project` accepts a Vercel project id or name. If you omit it, Doomain searches upward from the current directory for `.vercel/project.json` and uses its `projectId`.

The interactive wizard also uses `.vercel/project.json`, but only preselects the local project when the detected `orgId` matches the selected Vercel account or team.

## Provider And Zone Inference

When `--provider` is omitted, Doomain lists zones from every configured provider and chooses the longest zone that matches the target domain.

Example: for `api.dev.example.com`, a provider zone named `dev.example.com` wins over `example.com`.

If two providers have the same best matching zone, Doomain stops with `PROVIDER_ZONE_AMBIGUOUS`. Re-run with `--provider` to choose one:

```bash
doomain link app.example.com --project my-app --provider cloudflare
```

## Safety, Dry Runs, And Conflicts

Use `--dry-run` before applying changes:

```bash
doomain link app.example.com --project my-app --dry-run --json
```

Dry runs do not write to Vercel or DNS. They resolve the target project, provider, zone, and base Vercel DNS record. They do not add the domain to Vercel, fetch Vercel TXT verification records, or inspect current DNS records for conflicts.

DNS conflict rules:

- Existing exact records are skipped.
- TXT records can coexist at the same name.
- Same-name, same-type conflicts trigger an interactive override prompt or require `--force` in JSON/non-interactive mode.
- CNAME slot conflicts trigger an interactive override prompt or require `--force` in JSON/non-interactive mode because a CNAME cannot share a name with most other record types.

For real links, Doomain inspects the target `A` or `CNAME` DNS slot before adding the domain to Vercel. In interactive mode, it shows the existing and desired records and asks whether to override. In JSON mode, it fails with `DNS_TARGET_CONFLICT` instead of prompting.

Use `--force` only when you intend to replace conflicting DNS records or move an existing Vercel alias:

```bash
doomain link app.example.com --project my-app --force
```

`--force` can remove an existing Vercel alias from another project and add it to the target project.

Confirming the interactive DNS override only forces DNS writes. If Vercel says the domain is already assigned to another project, re-run with `--force` to move that Vercel alias.

Namecheap note: Namecheap's API writes DNS through `setHosts`, which replaces the full host list. Doomain reads all existing records first, applies planned changes in memory, preserves unrelated records, then submits the complete final record set.

## JSON And Agent Usage

Use `--json` for automation. JSON mode never prompts and writes exactly one JSON object to stdout.

Successful commands use this shape:

```json
{"ok":true,"data":{}}
```

Failed commands use this shape:

```json
{"ok":false,"error":{"code":"MISSING_ARGUMENT","message":"Domain is required."}}
```

JSON mode is also enabled automatically when stdout is not a TTY, which makes piped commands script-safe.

Use explicit commands for agents. The bare `doomain` command is interactive, and `doomain --json` returns an error that points agents to `doomain link --json`.

Useful agent-safe commands:

```bash
doomain link app.example.com --project my-app --json
doomain dns point app.example.com --target 203.0.113.10 --json
doomain providers list --json
doomain providers status --no-verify --json
doomain domains find hacktheandes.com --json
doomain domains list --provider cloudflare --domain example.com --json
doomain projects list --search my-app --json
doomain clerk domains add example.com --app app_123 --json
doomain schema --json
doomain schema link --json
```

The schema command prints machine-readable metadata for the documented command contracts:

```bash
doomain schema --json
doomain schema "providers connect" --json
```

## Programmatic API

Use `findDomainProvider` to perform the same discovery from TypeScript or JavaScript:

```ts
import {findDomainProvider} from 'doomain'

const match = await findDomainProvider({domain: 'api.hacktheandes.com'})
console.log(match.provider, match.account, match.zoneDomain)
```

The API checks configured provider accounts, tolerates failures from individual providers, and returns the longest matching DNS zone. Pass `provider` or `account` to constrain the search. When a provider cannot be checked, `complete` is `false` and `warnings` identifies the affected provider account.

## Command Reference

Use `doomain --help`, `doomain -h`, or `doomain help <command>` for oclif-generated help. Use `doomain --version`, `doomain -v`, or `doomain version` to print the installed version.

### `doomain`

Starts the interactive wizard.

```bash
doomain
```

### `doomain link [domain]`

Links a Vercel project to a domain and creates DNS records.

Common flags:

- `--domain <domain>`: target domain or base zone.
- `--subdomain <name>`: subdomain under `--domain`.
- `--apex`: use the root/apex domain.
- `-p, --project <project>`: Vercel project id or name.
- `--provider <id>`: DNS provider id.
- `--dry-run`: preview without writing.
- `--force`: overwrite DNS conflicts without prompting and allow Vercel alias moves.
- `--wait`, `--no-wait`: wait for DNS and Vercel verification. Default is `--wait`.
- `--timeout <seconds>`: wait timeout. Default is `300`.
- `--json`: output one JSON object.

Examples:

```bash
doomain link app.example.com --project my-app
doomain link --domain example.com --subdomain app --project my-app
doomain link --domain example.com --apex --project my-app
doomain link app.example.com --project my-app --dry-run --json
doomain link app.example.com --project my-app --force
```

### `doomain auth vercel`

Saves Vercel credentials locally.

```bash
doomain auth vercel --token vercel_token
doomain auth vercel --token vercel_token --team-id team_123 --json
```

### `doomain dns point <domain>`

Points an apex or subdomain at an IPv4 or IPv6 address, or a subdomain at a canonical hostname, using the matching configured DNS provider.

```bash
doomain dns point example.com --target 203.0.113.10
doomain dns point app.example.com --target origin.example.net --no-wait --json
doomain dns point app.example.com --target 203.0.113.10 --provider spaceship --account work --force --json
```

Common flags:

- `--target <value>`: required IPv4, IPv6, or hostname target.
- `--type <A|AAAA|CNAME>`: require a record type instead of inferring it.
- `--provider <id>`, `--account <alias>`: select a configured provider account instead of inferring one.
- `--ttl <seconds>`: DNS TTL. Default is `300`.
- `--dry-run`: preview without writing.
- `--force`: overwrite conflicting DNS records.
- `--wait`, `--no-wait`: wait for public DNS propagation. Default is `--wait`.
- `--timeout <seconds>`: propagation wait timeout. Default is `300`.
- `--json`: output one JSON object.

### `doomain dns remove <domain>`

Removes exact DNS records and verifies their absence. `dns delete` is an alias.

```bash
doomain dns remove app.example.com --type A --value 203.0.113.10 --dry-run --json
doomain dns remove app.example.com --type A --value 203.0.113.10 --json
```

Common flags:

- `--type <A|AAAA|CNAME|MX|TXT>`: required record type.
- `--value <value>`: expected exact value; required unless `--all-matching` is used.
- `--all-matching`: explicitly select every record matching the name and type.
- `--provider <id>`, `--account <alias>`: select a configured provider account.
- `--dry-run`: list selected records without deleting them.
- `--json`: output one JSON object and never prompt.

### `doomain dns diagnose <domain>`

Compares DNS provider records with the system resolver and independent public resolvers.

```bash
doomain dns diagnose example.com --json
doomain dns diagnose app.example.com --type A --target 203.0.113.10 --json
```

### `doomain auth logout vercel`

Removes saved Vercel credentials from the local config file.

```bash
doomain auth logout vercel
doomain auth logout vercel --json
```

If `VERCEL_TOKEN` or `VERCEL_TEAM_ID` are still set, they continue to override local config.

### `doomain auth clerk`

Saves and verifies a Clerk Platform API key and default application id.

```bash
doomain auth clerk --platform-api-key ak_123 --app app_123
```

### `doomain auth logout clerk`

Removes saved Clerk credentials. `CLERK_PLATFORM_API_KEY` and `CLERK_APPLICATION_ID` continue to override local config when set.

### `doomain clerk domains add <domain>`

Creates the application's first Clerk production instance and primary domain, then configures Clerk's returned CNAME records.

```bash
doomain clerk domains add example.com --app app_123
doomain clerk domains add example.com --app app_123 --dry-run --json
doomain clerk domains add example.com --app app_123 --no-wait --json
```

### `doomain providers list`

Lists supported DNS providers.

```bash
doomain providers list
doomain providers list --json
```

### `doomain providers connect [provider]`

Saves DNS provider credentials locally.

```bash
doomain providers connect cloudflare -c apiToken=token -c accountId=account_id
doomain providers connect namecheap -c apiUser=user -c apiKey=key -c clientIp=127.0.0.1 --json
doomain providers connect hostinger -c apiToken=token --json
doomain providers connect spaceship --api-key key --api-secret secret
```

Common flags:

- `-c, --credential key=value`: provider credential. Can be repeated.
- `--api-key <key>`: Spaceship compatibility alias for `apiKey`.
- `--api-secret <secret>`: Spaceship compatibility alias for `apiSecret`.
- `--no-verify`: save credentials without calling the provider API first.
- `--json`: output one JSON object.

### `doomain providers add [provider]`

Alias for `providers connect`.

```bash
doomain providers add cloudflare
```

### `doomain providers status`

Shows configured provider health.

```bash
doomain providers status
doomain providers status --no-verify --json
```

### `doomain providers verify <provider>`

Verifies saved provider credentials.

```bash
doomain providers verify cloudflare
doomain providers verify namecheap --json
```

### `doomain providers disconnect <provider>`

Removes saved DNS provider credentials locally. `providers logout` is an alias.

```bash
doomain providers disconnect cloudflare
doomain providers logout namecheap --json
```

Environment variables for that provider still override local config after disconnect.

### `doomain domains find [domain]`

Finds the configured DNS provider account with the longest matching zone. It checks all configured accounts and continues when an individual provider fails, so one expired credential does not hide a match from another provider.

```bash
doomain domains find hacktheandes.com --json
doomain domains find api.example.com --json
doomain domains find --domain example.com --provider spaceship --account personal --json
```

Successful JSON includes the provider, account, matching zone, and relative DNS record name. Check `complete` and `warnings` before treating the result as exhaustive; for example, an expired token may prevent one provider from participating in discovery.

### `doomain domains list`

Lists DNS zones and records.

```bash
doomain domains list --provider cloudflare
doomain domains list --provider cloudflare --domain example.com --json
```

If `--provider` is omitted, this command uses `DOOMAIN_PROVIDER`, then the saved default provider, then `spaceship`.

### `doomain projects list`

Lists Vercel projects for the configured Vercel account or team.

```bash
doomain projects list
doomain projects list --search my-app --json
```

### `doomain verify`

Asks Vercel to verify a project domain without changing DNS.

```bash
doomain verify --domain example.com --subdomain app --project my-app
doomain verify --domain example.com --apex --project my-app --json
```

For `verify`, pass a base domain plus `--subdomain`, or pass a base domain plus `--apex`.

### `doomain schema [command]`

Prints machine-readable command metadata.

```bash
doomain schema --json
doomain schema link --json
doomain schema "providers connect" --json
```

## Environment Variables

Vercel:

```bash
VERCEL_TOKEN
VERCEL_TEAM_ID
```

Clerk:

```bash
CLERK_PLATFORM_API_KEY
CLERK_APPLICATION_ID
```

Spaceship:

```bash
SPACESHIP_API_KEY
SPACESHIP_API_SECRET
```

Namecheap:

```bash
NAMECHEAP_API_USER
NAMECHEAP_API_KEY
NAMECHEAP_USERNAME
NAMECHEAP_CLIENT_IP
NAMECHEAP_SANDBOX
```

Cloudflare:

```bash
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Hostinger:

```bash
HOSTINGER_API_TOKEN
```

Doomain defaults and config:

```bash
DOOMAIN_DOMAIN
DOOMAIN_PROVIDER
DOOMAIN_CONFIG_DIR
DOOMAIN_CONFIG_FILE
DOOMAIN_DEBUG
```

Notes:

- `DOOMAIN_DOMAIN` is used by the interactive wizard and internal link planning, but the `doomain link` command currently still requires a positional domain or `--domain` before it calls the linker.
- `DOOMAIN_PROVIDER` is used by the interactive wizard and `domains list`. For `link`, pass `--provider` when you want to force a specific provider.
- Set `DOOMAIN_DEBUG=1` to enable provider debug mode where supported.
- Use `DOOMAIN_CONFIG_FILE` in tests or scripts when you want isolated credentials.

## Troubleshooting

`Missing Vercel token`

Run `doomain auth vercel` or set `VERCEL_TOKEN`.

`No DNS provider is configured`

Run `doomain providers connect <provider>` or set the provider's required environment variables.

`PROVIDER_ZONE_NOT_FOUND`

The selected provider does not have a DNS zone matching the target domain. Check `doomain domains list --provider <provider>` or pass the correct `--provider`.

`PROVIDER_ZONE_AMBIGUOUS`

More than one configured provider has the same best matching zone. Re-run with `--provider cloudflare`, `--provider namecheap`, `--provider spaceship`, or `--provider hostinger`.

Namecheap authentication or permission errors

Make sure Namecheap API access is enabled and your current public IPv4 is whitelisted in Namecheap API Access settings.

Cloudflare permission errors

Make sure the API token has `Zone:Read` and `DNS:Edit` permissions for the account that owns the zones.

Hostinger authentication errors

Make sure the API token is active and can access the domains you want Doomain to manage.

Hostinger DNS zone not found

Make sure the domain is active in Hostinger before linking it. Domains shown as `pending_setup` in Hostinger's portfolio API are not writable through the DNS zone API yet.

DNS propagation timeout

The DNS records may have been saved even if Vercel verification timed out. Check the domain in Vercel, inspect records with `doomain domains list`, or re-run verification with `doomain verify`.

DNS target conflict

The domain already has a conflicting `A` or `CNAME` record, which usually means it points to another project or site. In interactive mode, confirm the override only if you intend to replace that target. In JSON mode, re-run `doomain link` with `--force` to overwrite DNS.

Domain already assigned to another Vercel project

If you intend to move it, re-run `doomain link` with `--force`. This can remove the alias from the previous Vercel project.

SSL certificate is not ready yet

Vercel may need a few extra minutes to provision SSL after the domain verifies.

## Development

This repository is a TypeScript ESM oclif CLI package.

```bash
bun install --frozen-lockfile
bun run build
bun run test
```

Useful commands:

```bash
bun run lint
bun run check
bun run format
bunx mocha --forbid-only "test/path/to-file.test.ts"
./bin/dev.js link app.example.com --project my-app --dry-run
```

Notes for contributors:

- Source commands live in `src/commands/**`.
- Shared logic lives in `src/lib/**`.
- Build output goes to `dist/`; do not edit `dist` directly.
- `examples/**` is excluded from this package's Biome surface.
- Public command contract metadata lives in `src/lib/command-schema.ts`.
- `prepack` runs `oclif manifest && oclif readme`, which may update generated README command docs.

## License

MIT
