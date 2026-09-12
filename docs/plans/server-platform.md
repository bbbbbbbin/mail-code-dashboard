# Server platform — agreed scope

Status: implemented and verified with synthetic accounts; uploaded using Git CLI. GitHub's Windows/Linux Node 22/24 matrix and default Node 24 Docker build, tests and persistence smoke all passed for d817af7. No production migration or deployment yet.

## User decisions

- Linux + Docker Compose. Keep the existing local entry point and Chrome local mode working.
- One administrator dashboard, independently identified iCloud accounts, combined inventory view.
- Bind cookie uploads to an account and verify Apple's authenticated identity before replacing any secret.
- Generate a mailbox token **only on explicit distribution**. Distribution is permanent by default.
- Keep distribution separate from read/group status. Never automatically recycle a distributed address.
- Tokens can be revoked/reset; active sessions must observe revocation on every request.
- Test locally first; push using Git/GitHub CLI, never browser file uploads.

## Architecture

A new hosted entry point composes account-scoped stores, iCloud clients, mailbox readers and generation queues. Existing `server.mjs` remains local-only. A single hosted writer owns its data directory. HTTPS ingress is separate from the internal HTTP listener. Admin sessions, program keys, upload keys and mailbox tokens have separate scopes. Persistent credentials are encrypted using an externally supplied master key. Random access keys are stored as hashes only. No open signup endpoint.

## Acceptance checks

Account mismatch and concurrent uploads; permanent distribution and duplicate clicks; mailbox authorization and body-only false matches; session revocation; CSRF; credential redaction; container restart/persistence; local compatibility; migration dry-run and rollback documentation.

## Required NEXT step: migrate BOTH existing local instances

After the server release is accepted, migrate port 4173 (A) and port 4174 (B) separately. Do not create empty inventories in place of their existing state. Preserve email addresses, Apple labels/identifiers, notes, groups, read/mail state, claim history, label counters, forwarding configuration, backups and automatic-generation cooldowns. Never put real data or export bundles in GitHub or Docker images.

Sequence: backup both sources → identify destination accounts → preview and compare counts/ownership → stop each source's automatic generation → take final consistent export → import into a paused destination → reconcile and verify → enable destination generation. Keep source backups and a rollback plan. Existing local API keys are not public server credentials. No distribution token is created by migration. Never run two generators for the same Apple account during cutover.

Do not execute this migration as part of building the hosted platform.
