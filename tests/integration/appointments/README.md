# WMO Appointment disposable MySQL harness — Phase 4A

This is an **offline foundation**, based on commit
`97872ea96e3cf01035f3dac52a5fadfe74e63a72`. It does not connect to a database,
provision infrastructure, execute fixture SQL, load application routes or send messages.
**An offline harness PASS is not a MySQL compatibility PASS.**

## Authorized commands

From the repository root, using the existing Node 22 toolchain:

```powershell
node --test --test-reporter=tap tests/integration/appointments/harness.offline.test.cjs
node tests/integration/appointments/run.cjs --self-check
```

The repository's intended CI runtime is Node 22. The available system runtime for
this implementation check was Node 24.14.1; Node 22 execution remains a separate
compatibility check. No runtime was installed or downloaded by this harness.

The launcher supports exactly one argument, `--self-check`. No arguments,
`--integration`, `--provision`, `--force`, `--unsafe`, extra arguments and combined
modes return a nonzero safe refusal. There is no hidden integration mode. The
self-check runs eight in-process checks and creates no files or subprocesses.
The independent offline suite uses isolated **Node-only** child processes with
network, production-module, subprocess and filesystem-write traps installed
before importing the harness. Trap counts and deliberately blocked negative
controls distinguish prevention from an actual external connection.
The interception negative controls themselves run in the guarded Node test worker;
they do not need another child carrying prohibited-operation test code. The guarded
methods throw before creating a socket, loading a provider, launching a process or
writing a file. All patched methods are restored after each test.

## Phase boundaries

| Phase | Scope | Status |
| --- | --- | --- |
| 4A | Pure guards, inert specifications, deferred interfaces, offline tests | Implemented here |
| 4B | Review exact official image digest, local Docker identity, isolated provisioning and fixture execution configuration | Not implemented or authorized |
| 4C | Separately authorized write-capable integration suites and real MySQL evidence | Not implemented or authorized |

The four proposed `.mysql.cjs` integration suites do **not** exist in Phase 4A.
No production file, existing test, package/lockfile, migration or CI workflow is
changed. Do not run the application or import `config/db.js`, `config/dbPromise.js`
or `server/server.js`: these modules can create pools/connections or other effects.

## Modules

- `helpers/environment.cjs`: pure, strict evidence validation; child-environment
  allowlisting; non-executable owned-resource teardown plans; inert Compose check.
- `helpers/schema.cjs`: independently authored five-table synthetic specifications,
  metadata model and qualified fixture DDL **strings only**. No SQL executor.
- `helpers/runtime.cjs`: explicit deferred dependency boundaries. Factories are not
  called or retained; activation, connection, route loading and fixture execution
  always refuse. Provider guards always block delivery.
- `helpers/control.cjs`: per-instance named barriers, arrival observation,
  release/cancel/abort/failure, bounded timers and test-adapter fault points.
- `helpers/assertions.cjs`: pure snapshot invariants and whitelisted offline evidence.
- `run.cjs`: offline self-check and nonzero refusal for every other mode.

## Identity contract and trust limits

Pure validators cannot discover or authenticate Docker/MySQL. Caller-provided
booleans and mock evidence do not establish independent verification. All accepted
results explicitly retain `offlineOnly: true`, `writeAccess: false` and
`independentlyObservedHere: false`; they are **not activation tokens**. A later
implementation needs independently observed, authenticated evidence and new
owner authorization. There is no operational activation path in this version.

The expected manifest binds a run UUID to an exact 64-hex container/network ID,
owned volume name, purpose/run labels, official `mysql:9.7.2-oraclelinux9` image
and verified full digest, baseline commit, synthetic schema, server UUID,
fixture fingerprint, separate test-only account descriptors and one permitted
schema. Descriptors contain **no passwords or connection strings**.

Only literal `127.0.0.1`, TCP, a declared host port and container port 3306 are
admitted. DNS/localhost, URLs, other hosts, extra published ports and ambiguous
bindings are refused. Future observations must include the actual socket
endpoint, not merely a configured host. Future provisioning must verify the
local Docker context, image, network/firewall behavior and container identity;
a loopback address alone could point at a tunnel and is not isolation evidence.

Provisioning identity requires an independently observed empty synthetic schema
before initial fixture writes. Runtime identity additionally requires a matching
synthetic-only run marker, fingerprint, source commit and explicit reconciliation
attestation. The identity marker is separate from application readiness. These
validators neither set the readiness flag nor prove reconciliation occurred.

The child-environment builder reads only `SystemRoot`, `WINDIR`, `TEMP`, `TMP`
and sets fixed test phase/UTC values. It does not enumerate or inherit
`DATABASE_URL`, Railway/Render/provider credentials, `NODE_OPTIONS`, `NODE_PATH`,
dotenv configuration or PATH. A future child must use an absolute reviewed Node
executable. Account credentials must be newly provisioned for the disposable
instance, never discovered from production environment files.

## Inert Compose and synthetic schema

`compose.yaml` has `services: {}`. Its extension is documentation, not a runnable
database service. The digest is deliberately absent. Do not run Docker commands
in Phase 4A. Phase 4B needs a separately reviewed configuration change, exact
digest verification, dedicated network, loopback-only publication, no X Protocol
publication, resource limits, no production mounts/dumps and owned-resource IDs.

The fixture defines InnoDB appointments, notifications, reservations, booking
requests and feature state. It preserves signed INT appointment IDs, unsigned
BIGINT revisions, nullable initial links, ASCII/binary hashes/service keys,
DATE/TIME(0), Philippine wall-clock DATETIME(0), existing timestamp conventions,
required full uniqueness and same-schema RESTRICT foreign keys. Larger reviewed
legacy string sizes are retained. Defaults are **synthetic choices**, not evidence
of actual production defaults. The source of truth is the committed contract,
not a runtime import of the validator.

Fixture DDL is new synthetic CREATE data, not an uncommented production migration:
no ALTER, database/user creation, GRANT, DROP, backfill or activation statements.
It qualifies every table to a strict run-specific schema. The only feature marker
has `schema_version = 1`, `backfill_complete = 0`. No helper attests readiness or
sets it to one. Schema fingerprinting covers definitions, DDL templates and the
synthetic fixture contract. The production commented draft remains untouched.

## Controls, invariants and evidence

Each controls instance owns its own named barriers; there is no global mutex.
Waits and arrival observers have 1–5000 ms bounds (default 2000 ms). Timeout or
failure rejects the barrier participants, and disposal clears pending timers and
abort listeners. Attach rejection handlers when starting concurrent waits and
always use `withControls`/`finally` cleanup. A timer is a test watchdog, not an
application transaction deadline. Fault points only throw fixed adapter errors;
they do not implement network faults or prove InnoDB concurrency.

Snapshot assertions expect normalized synthetic observer rows, ordered arrays,
numeric safe IDs/revisions and SQL-format date/time strings. They cover capacity,
links/orphans, active reservation requirements, rejected/cancelled release,
booking/notification deltas, changes, recovery, Philippine boundaries and terminal
method **attempts**. Completed/no-show orientation reservations may remain, matching
the existing lifecycle. Historical rows need not possess new idempotency records.
Count-based notification atomicity needs an isolated before/after operation because
the existing WMO notice has no appointment foreign key. A snapshot assertion cannot
prove server durability or successful socket disposal.

Evidence is explicitly `offline-model` with `durableVerified: false`, unverified
engine version, zero database queries and strict identifier/enumeration/count
fields. Unknown fields and unsafe values fail with fixed diagnostics. No citizen
data, passwords, session cookies, bearer tokens, raw SQL/driver errors or sensitive
URLs belong in evidence. Future real-database evidence needs a separate reviewed
format and independently observed persistence.

## Future execution and cleanup

Future families: A schema compatibility; B capacity/concurrency; C transactions and
idempotency; D Philippine time/driver coercion; E staff/orientation/notifications;
F latency/pools; G negative readiness/recovery. Independent connections and observed
lock waits must replace the existing serialized model for concurrency evidence.

Activation requires a new implementation and separate GO EXECUTE authorization.
Before any later write: verify host/container/schema/server UUID, run marker,
fingerprint, grants and synthetic reconciliation. Never relax the production
validator to make a fixture pass. Do not execute the commented migration draft.

Teardown planning compares exactly the three recorded container/network/volume
identities and both ownership labels; extra, duplicate or unowned resources fail
closed. It returns data only, never commands. Future execution must drain tests,
close listeners, dispose leases/observers and reverify identity before exact owned
resource removal. No wildcard cleanup or global prune. Quarantine ambiguous targets.

Real MySQL metadata visibility, DATETIME/driver conversion, InnoDB races, transport
failures, historical encoding/backfill, legacy writers, production schema/version,
shared notification UNIQUE indexes, runtime notification DDL and pool exhaustion
remain unverified. Reconciliation-before-invalid-quiz validation, certificate
security and R2 denial-related connection churn remain separate concerns. A normal
rolling deployment, production activation or mixed old/new writer fleet is not
authorized by an offline PASS.
