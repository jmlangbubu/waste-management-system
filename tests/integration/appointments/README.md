# Appointment disposable MySQL harness — Phase 4B preparation

This directory is test-only. No real Docker/MySQL executor is installed.
A successful mock protocol is not database, isolation, durability or production evidence.

## Current executable modes

From the repository root:

    node tests/integration/appointments/run.cjs --self-check
    node tests/integration/appointments/run.cjs --plan
    node --test --test-reporter=tap tests/integration/appointments/harness.offline.test.cjs

Self-check retains the original eight Phase 4A checks and output.
Plan prints non-secret requirements, unresolved digests and capabilities; it reads no
environment file and does not inspect Docker, Git, the network or MySQL.
No arguments, unknown arguments and bypass arguments exit 2.
The recognized --provision, --verify, --attest and --teardown modes also exit 2:
PHASE4B_NATIVE_UNSUPPORTED. They do not load a process or database adapter.

| Interface | Implemented behavior | Native execution |
|---|---|---|
| Self-check / plan | Inert local computation | None |
| Identity/configuration validators | Strict, frozen pure DTO checks | None |
| Manifest proof | Digest and platform-chain checks on supplied bytes | No registry authentication or fetch |
| Command/account/fixture recipes | Inspectable, non-executable data | No commands, secret generation or SQL |
| Mock lifecycle | Scripted in-memory protocol and admission tests | None |
| Native lifecycle | Explicit refusal | Unsupported |
| Application pools / route loading | Explicit refusal; integration contract only | Unsupported |
| Phase 4C suites | Not implemented | Not authorized |

No real execution capability can be minted from a flag, approved boolean, returned
writeAccess object, callback, cloned scope or supplied observation DTO. Module-private
WeakMaps bind mock scopes to one scripted transport, configuration, run and action.
They remain mock-only. Native execution fails before importing mysql2/child_process.

## Preserved Phase 4A foundation

The five-table Phase 4A specification, fingerprint algorithm, deferred runtime,
provider guards, evidence class and controls remain intact. Pure identity acceptance
always retains offlineOnly=true, writeAccess=false, independentlyObservedHere=false.
They are never database write permits.

The original ownership, phantom-arrival and sanitized-diagnostic regressions remain.
The offline suite installs network, server, DNS, production-module, filesystem-write,
environment-file and subprocess traps, including before helper imports. Child probes
use an absolute Node executable and explicit OS-plumbing-only child environment.
The updated Compose assertion additionally checks the opt-in Phase 4B template.
The original inert Compose validator and its negative controls remain covered.

Control scopes still own independent named barriers, with no global mutex.
Waits and observers remain bounded to 1–5000 ms, default 2000 ms.
Invalid/pre-aborted waits cannot create arrivals. Always attach rejection handlers
and dispose controls; a test watchdog is not an application transaction deadline.

## Explicit source identities

Application under test: R3 97872ea96e3cf01035f3dac52a5fadfe74e63a72.
Phase 4A harness checkpoint: 9d582f5691dc9d09798a97f300c356d9890e1b93.
A future execution must observe its own clean, reviewed harness commit and manifest;
there is no self-referential future commit SHA embedded in implementation code.

APPLICATION_FILES pins the reviewed raw bytes of the scheduling service, policy and
package lock independently of the harness revision. Any different bytes fail closed,
including line-ending changes. No automatic normalization/rebasing is performed.
Future suites loading additional application modules must extend this manifest
explicitly. Current scripted Git observations are not real source verification.

The old fixture sourceCommit remains R3. The separate provisioning profile is
wmo-appointments-p4b-v1; its fingerprint covers the old fingerprint, control-table
definition, seed variant and unready defaults. Run-specific application/harness
identities are recorded separately in appointment_harness_identity.

## Image and local Docker contract — unverified on a real host

The only candidate is mysql:9.7.2-oraclelinux9. No real digest is embedded or approved.
Configuration requires distinct full image-index, platform-manifest and image-config
digests; supplied manifest bytes must hash to them and select the exact Linux
architecture. The config/image ID is not interchangeable with a manifest digest.
Synthetic digest fixtures are explicitly fabricated and must never be pulled.

Require a reviewed local Docker context/named pipe, Linux Engine >=28.0.0, matching
native architecture, reviewed executable hashes and official Node 22.23.5 identity.
Refuse remote daemons, moving tags, substituted versions or missing inputs.
Actual registry provenance, image distribution and server-version observation still
require a native adapter. Expected server distribution is MySQL Community Server - GPL;
expected image OS is Oracle Linux 9. These are requirements, not observed results.

Each run owns one UUID-derived container, internal bridge network and local data
volume. All carry exact purpose/run labels. Require exactly those identities,
network members and mounts, 2 CPUs, 1 GiB memory, restart=no, privileged=false,
mysqlx disabled, and exactly one literal 127.0.0.1 publication to TCP 3306.
Reject extra ports, IPv6 publications, host networking and Docker socket mounts.
Dockerfile EXPOSE metadata alone is not an actual published socket.

Windows Docker Desktop forwarding and internal-network host reachability are NOT
verified. Engine >=28 is necessary but not sufficient isolation proof. A future
observer must verify actual socket destination, listener/forwarder, resource identity
and egress boundary. If the internal network cannot safely support the host client,
STOP; do not automatically add an external network or broaden host publication.
A no-publication co-located runner is a separately reviewed alternative.

## Compose preparation

compose.yaml uses canonical JSON, a YAML subset, to avoid adding a YAML dependency.
It defines one wmo-disposable profile with mandatory unresolved run/image/port/secret/
scope inputs, a dedicated internal network and volume, fixed limits and no restart.
There is no default-active service. Do not invoke Compose during offline work.

A profile or WMO_EXECUTION_SCOPE value is NOT authorization. A future native runner
must select the exact reviewed file and an explicit, run-owned NON-SECRET input file,
disable automatic .env loading, reject implicit override files and pass an allowlisted
child environment. Never run Compose with inherited DATABASE_URL, NODE_OPTIONS,
NODE_PATH, provider credentials or arbitrary COMPOSE/DOCKER settings.

Only the owned data volume and two newly created, read-only bootstrap secret files
are contemplated. No production mounts, credentials, dumps or application startup.
No real credential generation, ACL management, secret delivery/deletion, image pull
or Compose invocation is implemented.

## Accounts and privileges

Run-specific setup/application/observer account names are deterministic descriptors,
not real accounts or credentials. No passwords are accepted by configuration.

- Setup: table-scoped CREATE/SELECT/INSERT, parent REFERENCES, and only the two
  reconciliation/readiness column UPDATE privileges.
- Application: appointments SELECT/INSERT/UPDATE; reservations SELECT/INSERT/UPDATE/
  DELETE; requests SELECT/INSERT/UPDATE; notifications INSERT; feature state SELECT.
  No access to the harness identity table.
- Observer: SELECT on the six synthetic tables, no writes.
- No global administrative privileges, inherited roles or grant option.

grantRecipe produces separate inert account-creation and table-qualified grant
recipes. Password parameter slots contain role names, not secret values. It requires
a literal, privately scoped observed client host and refuses host wildcards/URLs.
Table qualification makes schema underscores literal; never replace it with an
unescaped schema.* grant. Real authenticated-account matching, effective SHOW GRANTS
normalization and role observation remain native-unsupported. Bootstrap root must
remain container-local on the verified disposable instance.

## Fixtures, reconciliation and explicit attestation

The original five InnoDB application tables retain signed appointment IDs, unsigned
revisions, nullable initial request links, full unique slot keys, ASCII/binary keys,
restricted same-schema foreign keys and reviewed notification defaults.
Phase 4B adds one TEST-ONLY appointment_harness_identity table with run/schema,
application/harness revisions, profile/fingerprint, synthetic-only and reconciliation
fields. It is not a production requirement.

All generated table/seed/attestation SQL is inert and fully schema-qualified.
Setup contains no ALTER/DROP/backfill/production-migration execution or readiness=1.
Feature state starts at schema_version=1, backfill_complete=0; identity reconciled=0.
The seed is one synthetic pending accreditation booking with linked reservation,
request and notification. The synthetic staff DTO is not a User Management row.
The fixture clock/date are fixed and explicitly recorded; real timezone/driver
behavior is unverified. Do not treat this seed as production schema/default evidence.

The mock lifecycle separates bootstrap, empty-schema admission, fixture creation,
grant admission, fresh metadata/snapshot reconciliation, explicit attestation and
post-commit observation. Only a distinct attest scope can request the conditional
two-update protocol. It requires modeled row locks, one affected row per update,
acknowledged commit and matching post-commit state. No mock acknowledgement proves
an actual lock/transaction. Uncertain commit or failed reconciliation quarantines
the model. Partial DDL failure never claims a rollback removed created tables.

Native attestation is NOT implemented. A real adapter must reobserve/lock/reconcile
the disposable state atomically and independently before enabling only its marker.

## Isolation, evidence and cleanup

Do not import config/db, config/dbPromise, production routers or server/server.js.
The scheduling-service constructor can later receive a disposable pool/fixed clock
and constructor-only enablement; this change neither loads it nor enables production.
Routes/providers remain unsupported or guarded. No real pools are opened.

Phase 4A evidence remains offline-model. Separate Phase 4B evidence is currently
mock-provisioning-protocol, with zero actual Docker commands/database queries,
nativeVerified=false, connected=false, durableVerified=false and writeAccess=false.
Only fixed safe stages, digests, revisions, schemas, counts and invariant labels
can appear; no raw SQL, passwords, cookies, tokens or native exception content.
Expected/observed invariants are explicitly labeled mock-match.

Teardown reobserves the pinned daemon and exact resources/labels, verifies modeled
workers/connections/providers drained, then models stop and exact-ID removal.
No --force, wildcard cleanup, broad Compose down or prune. Changed/ambiguous targets
are quarantined. dispose does not claim external cleanup occurred.

## Remaining operational work and separate authorization

Native execution remains unsupported because this task has no approved native
execution authority, authenticated observation adapter, Windows isolation proof,
credential ACL/transport implementation or effective-grant parser. Inventing those
proofs from caller DTOs would break the safety boundary. Scripted successes cannot
unlock this path. The fixed command/SQL recipes are not a generic executable runner.

Next independent review should focus on configuration/admission, observation
provenance, source manifests, fixture fingerprints, least privilege, attestation
separation, cleanup identity and guard/mutation-test quality.

Before any real execution: separately review/implement the native adapters, approve
a clean harness revision and exact image/platform digests, establish Node 22.23.5
compatibility and prove local isolation. Node 22 execution is still UNVERIFIED;
no installation, PATH change or dependency upgrade is included.

Phase 4C remains separate: schema/grants/readiness; real capacity/races; transaction/
fault/idempotency/durable recovery; Philippine time, staff/orientation/notifications.
Independent connections/lock observations must replace serialized mocks. Production
schema/defaults, transport behavior, existing orientation dependencies, certificate
security and activation/backfill remain outside this offline evidence.
No Git publication, production activation, migration or deployment is authorized.
