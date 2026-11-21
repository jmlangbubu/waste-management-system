# Appointment disposable MySQL harness

Native adapters are implemented for offline review. **Real execution remains
blocked:** source-owned OWNER_TRUST is null. No owner key/signing procedure,
approved immutable image digests, Node22 verification or installed dependency
tree is available. Offline success proves no Docker isolation, connectivity,
booking correctness, durability or production parity.

## Safe commands

    node tests/integration/appointments/run.cjs --self-check
    node tests/integration/appointments/run.cjs --plan
    node --test --test-reporter=tap tests/integration/appointments/harness.offline.test.cjs
    node --test --test-reporter=tap tests/integration/appointments/native.offline.test.cjs

The eight Phase4A checks, pure five-table contract, fingerprints, assertions and
controls remain intact. Individual provision/verify/attest/teardown modes and
unknown/bypass arguments still refuse. --native-smoke refuses before stdin,
native transports or challenge randomness while the owner key is missing.

Both test suites intercept network/process/filesystem/production-module effects.
The native tests additionally intercept credential generation. Fixed synthetic
signing keys and fake host/ACL/Docker/registry/MySQL responses cannot select real
drivers. Their evidence is offline-native-protocol, with nativeVerified=false,
connected=false, durableVerified=false and zero native command/query counts.

## Boundaries and authorization

- nativeHost: signatures, private sessions/scopes, source/binaries, Windows ACLs,
  recovery journal and sanitized child environment.
- nativeDocker: fixed CLI operations, official registry bytes, owned resources,
  actual bindings/routing and exact removal.
- nativeMysql: finite root protocol, accounts/grants, fixture metadata/transactions,
  explicit attestation and pinned-TLS connections/pool.
- nativeLifecycle: stage ordering, permits, cancellation/quarantine and evidence.

No import performs native work. No general-purpose SQL/subprocess API is exposed.
Docker command tokens and adapter identities are private and session-bound.
Public scope guards disclose no mutable state. Mock sessions cannot become native
sessions. The real factory rejects test challenges and caller-supplied trust keys.

A separately authorized source change must establish the owner's Ed25519 public
key and signing procedure. No flag, environment variable or receipt configures
that trust anchor. Receipt format is {payload,signature}, signature canonical
base64 over UTF-8 JSON with recursively sorted object keys and retained array
order. Exact payload fields:
- version:1; trusted owner; fresh challenge nonce (64 lowercase hex).
- issuedAt/expiresAt, maximum fifteen-minute validity.
- configuration: exact Phase4B configuration, including source manifest, reviewed
  harness commit, application hashes, run/schema, fixture, binaries and digests.
- execution: daemonId, ownerSid, dependencyRoot, dependencyHash,
  backendExecutable, backendHash.
- actions: provision, verify, attest, connect-check, teardown; distinct and explicit.

The future stdin protocol has two bounded JSON lines: configuration, then the
signed receipt after an unsigned challenge is printed. This is currently
unreachable. No receipt-file discovery is performed. Actual use separately
requires GO EXECUTE. The smoke command requires all action permits before any
provisioning; provision alone cannot attest.

Private scopes belong to one lifecycle/run/action, cannot be cloned/serialized,
and consume write permission before dispatch, including failed writes. Challenge
admission is one-time. Source/environment failure, cancellation and disposal revoke
remaining permits. An exclusive owner-restricted directory/journal prevents
cross-process run reuse. Interrupted recovery always requires fresh approval.

Application baseline is R3 97872ea96e3cf01035f3dac52a5fadfe74e63a72.
APPLICATION_FILES retains the raw-byte hashes. Execution must observe its own
clean reviewed harness commit. Harness-manifest SHA256 covers nativeHost.FILES
in declared order as canonical {path,sha256} entries; no newline normalization
or self-referential future commit is used.

## Docker and registry

One provisioning path: reviewed absolute docker.exe, argument arrays, shell:false,
explicit approved local named pipe and private config directory. Independently
read the expected context's non-secret metadata. Inherit no Docker/Compose
overrides, credentials, DATABASE_URL, provider keys, NODE_OPTIONS/NODE_PATH or
proxies. Windows system PowerShell/Git paths are fixed; other layouts stop.

Require native architecture, Linux Engine>=28, reviewed executable hashes and
stable approved daemon ID. Reject remote contexts, mirrors and unreviewed proxies.
HTTPS registry/token origins and library/mysql:pull scope are fixed. Hash bounded
raw manifest bytes before parsing, then reuse descriptor/platform validators.
All redirects, including CDN redirects, are refused. An encountered redirect is
a compatibility STOP, not authority to widen transport. No digest is invented.

Pull only the approved platform digest. Creation uses --pull=never. Create one
labelled container/network/local volume. Verify full container/network IDs;
volume name, driver/scope, fresh creation evidence and mount association; upstream
image labels separately from ownership labels; only intended network members;
two CPUs, 1GiB, no privilege/restart/extra mounts; only literal loopback TCP3306
publication; disabled X Plugin. EXPOSE without a binding is not publication.

The native network is internal, IPv4-only, with gateway mode isolated. If this
prevents host access, STOP; do not broaden networking or silently add a co-located
runner. The Compose file has empty services and only an x- reference: no runnable
services/networks/volumes/secrets. Profiles and metadata confer no authority.
An independently privileged Docker administrator can bypass any launcher.

## Windows secrets and isolation

Generate fresh disposable root/setup/application/observer base64url passwords only
after authorization. A protected owner/SYSTEM-only DACL, disabled inheritance,
exclusive creation and reparse checks precede secret writes. Root files mount
read-only. App/observer passwords stay in memory. Never discover .env or expose
passwords through argv/logs. Cancellation clears session-held secrets.

Observe actual loopback listener/backend, enabled blocking firewall profiles and
absence of broad backend inbound allow rules. Inspect container routes for
default/host gateways and unintended IPv6. Ambiguous/inaccessible policy stops.
These strict checks may reject a normal Desktop setup; no firewall change is
automatic. Actual LAN/egress isolation still requires separately approved
negative reachability probes; configuration/fake responses are not proof.

## MySQL protocol

Root is limited to the exact owned container's Unix socket/protected option file.
Fixed SQL arrives on stdin. Finite operations validate roles/hosts/tables/password
slots; no arbitrary SQL or database identifier is accepted. Administrative text
templates use a restricted generated-password alphabet; administrative prepared
statement placeholders are not assumed valid.

1. Verify server UUID/MySQL9.7.2/distribution/X Plugin and Oracle Linux9.
2. Correlate a held host greeting's connection ID with server-side address.
   No guessed address or wildcard account host.
3. Create only synthetic schema and three accounts requiring TLS.
4. Grant initial table-scoped setup CREATE/INSERT/SELECT and required REFERENCES;
   independently prove the schema empty.
5. Execute unchanged six-table DDL; only afterward grant the two setup update
   columns, reviewed application rights and observer SELECT.
6. Observe effective grants and granted/default/mandatory roles/proxy privileges.
7. Execute unchanged bound seed DML in an explicit transaction.
8. Independently observe actual metadata and synthetic rows.

No global privileges, GRANT OPTION, production migration or readiness shortcut.
The approved wmo-appointments-p4b-v1 profile and both fingerprints are unchanged.
Partial DDL is quarantined; rollback is never claimed to remove created tables.
Initial schema_version=1, backfill_complete=0 and reconciled=0 remain unready.

Attestation requires fresh reconciliation and a separate permit. It locks all six
tables deterministically, rechecks metadata/rows, applies only the two approved
conditional updates, requires one affected row each and acknowledged COMMIT, then
uses a new observer connection to verify committed markers. No app writer enters
earlier. Production feature flags remain untouched.

Harness transactions save/restore only their own session timezone. Failed
rollback/restoration retires the connection. Uncertain COMMIT destroys its lease,
revokes writes and quarantines; no replay or readiness claim. Settled persistent
state must later be independently inspected with fresh approval. Crash durability
remains Phase4C; durableVerified stays false.

## mysql2 and cleanup

Lockfile selects mysql2 3.20.0; this worktree has no node_modules. No installation
is performed. Lazy loading requires an approved isolated dependency tree whose
regular files hash to the signed dependencyHash in sorted traversal order.
Reject symlinks/environment files/unexpected driver version; no NODE_PATH search.

Use explicit loopback/schema/account options; five-second connect/query/acquisition
bounds; one application-pool connection and separate setup/observer connections.
Disable multiple statements, LOCAL_FILES and debugging; return deterministic date
strings. Import no production pools/routes/server/provider clients.

Trust only the fresh CA/public server certificate read from the owned container.
Verify certificate signature/validity and exact TLS1.2/1.3 peer certificate/socket
before SQL. rejectUnauthorized stays true. verifyIdentity=false is explicit:
autogenerated MySQL CNs do not name loopback; run-specific CA and leaf pinning
supply identity. No plaintext/permissive-TLS fallback. The mysql2 TLS stream API
is version-coupled and requires checking against the approved installed tree.

Journal intent before effects and observed IDs afterward. Timeout does not mean
an operation never happened. Ambiguous stages preserve the journal and quarantine.
Successful teardown drains connections/pool/providers, rechecks source/daemon/
ownership, stops/removes the exact container/network/volume, verifies absence,
deletes only recorded ACL-verified files and the empty owned directory. Failure
cannot report completed cleanup. No force/prune/wildcards/Compose teardown.
Image-cache deletion is outside cleanup.

Recovery is intentionally not automatic adoption. Preserve signed identity and
journal, obtain fresh approval, independently resolve resources/persistent
markers, then authorize exact cleanup. Unknown resources remain quarantined.
There is no generic repair/recovery SQL interface.

## Separate execution gates

Before real execution: focused independent review of effectful boundaries;
approved owner key/signing procedure; clean reviewed commit; exact Node22.23.5
binary and locked dependencies; passing offline/self-check/refusal and all nine
appointment/orientation regressions under Node22; approved daemon/context/image
digests/run/schema/actions/credentials/isolation probes/cleanup.

Node22, installed-driver behavior, registry redirects, server startup/host-address
observation, Windows ACL/firewall behavior, TLS and internal-network host access
remain real-environment gates. Node24/mock success does not establish them.

Phase4C is separate: real booking capacity/races, cancellation/rescheduling,
idempotency, fault/uncertain-commit settlement, durability/recovery, Philippine
time and staff/orientation/notification preservation. No activation, migration,
deployment, Git publication, production or Android change is authorized.
