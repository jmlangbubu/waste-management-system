# Appointment migration/backfill — synthetic staging only

This package is inert on import. Current authorization covers coding and offline
tests only. It never loads dotenv, application pools, booking routes, Docker,
provider clients, production data or private keys. No application feature flag
is set. All real cases are skipped by default.

## Evidence and explicit assumptions

The supplied aggregate findings describe 11 appointments: Accreditation approved
1/rescheduled 1; orientation pending 4/completed 2; Others pending 3. The original
fixture has the two historical active collisions at Accreditation 2026-10-27
10:00 and orientation 2026-11-06 09:00. Orientation 2026-10-08 15:00 has one
active and one completed row. The fixed analysis instant is 2026-11-22 12:00
Philippine time. Remaining synthetic schedules are illustrative; no additional
production date distribution is claimed. All names, IDs, contacts, references,
notifications, accepting staff and orientation evidence are invented.

The pre-migration fixture has 23 appointment columns, eight notification columns,
and a minimal synthetic quiz child. Reviewed Q4 shapes and the previous staging
fixture are used; literal defaults, the quiz child column name/layout/actions,
and absence of triggers are **synthetic profile assumptions**, not verified full
production DDL. The profile is explicitly acknowledged at the execution gate.
Unexpected columns/types/defaults/generated fields, unique indexes, triggers or
missing trigger visibility refuse execution. Actual production compatibility
still requires separate metadata/default/trigger/FK review. This is not a clone
or an executable production migration.

## Completed records and conflicts

The existing rollout README lines 246–249 states that existing orientation holds
remain and terminal historical rows need no invented new capacity. The quiz
completion route does not delete reservations. Accordingly:

- Pending/approved/rescheduled, including historical dates, require reservations.
- Completed legacy rows get no newly invented reservation; records/evidence stay.
- An existing completed/no-show hold is preserved. A competing active claim
  blocks readiness; no winner or release is selected automatically.
- Rejected/cancelled rows cannot retain a reservation.
- Status normalization is the application's JS trim/lowercase/null-to-pending.
  Unknown aliases such as `accepted` do not silently become approved.
- Purpose keys and seven times come directly from appointmentPolicy.js. Stored
  DATETIME strings are Philippine wall time, never reinterpreted as UTC.

The reconciled variant independently moves two **synthetic** schedules. It does
not change status/evidence or recommend any action on real WMO records.

## Migration, verification and uncertainty

Five separately acknowledged steps create feature state with readiness 0, append
the unsigned revision column, and create the two other infrastructure tables.
DDL can auto-commit. On a failure, journal attempted/acknowledged steps and stop;
there is no DROP/rebuild, DDL rollback claim or automatic partial-DDL replay.

Before inserts, verify the legacy profile, preserved quiz FK, InnoDB, exact new
column definitions, full unique keys and new signed-INT FKs. No legacy row,
notification, staff field or orientation evidence is updated by the backfill.
No historical request hashes are fabricated.

Reservation inserts use one real transaction with locked source/target rows.
Readiness remains 0 after this commit. A separate SELECT-only observer takes a
consistent snapshot under REPEATABLE READ and verifies committed reservations
and unchanged legacy data. Optional attestation locks and rechecks that snapshot,
sets 1 inside the transaction and runs the actual scheduling-service readiness
validator on the same leased connection before commit. This invokes metadata
validation only; it does not enable booking or change an environment flag.

A repeated populated run is verify-only and cannot promote readiness. Lost
backfill commit acknowledgement reports uncertainty and prevents replay. Lost
attestation acknowledgement attempts local readiness invalidation; if that is
unconfirmed, readiness is UNKNOWN and manual review is required. Controlled
faults are labelled as such, not genuine network/engine-failure evidence.

Snapshot rechecks detect the modeled/intercepted writer change. They cannot
prove safety against future or nonparticipating writers after attestation.
Production cutover still requires external writer freeze/drain and independent
reconciliation. No production cutover is authorized by these tests.

## Offline verification

With WMO_APPOINTMENT_MIGRATION_EXECUTE absent, run the verified Node 22.23.5:

    & 'C:\Users\ADMIN\Tools\wmo-node22-verified\node-v22.23.5-win-x64\node.exe' --test tests/appointmentMigrationDryRun.test.js

Offline model tests cover A–I, DDL persistence, DML rollback, uncertain commits,
repeat refusal, preserved evidence, invalid records, target gates and metadata.
They share orchestration with the SQL adapter but are not MySQL durability proof.

## Future separately authorized real execution

Do not use either existing MySQL container, especially
`wmo-appointment-stage-20261122-8ac4ef3e` or `wmo-complaint-mysql-lab`.
Prepare a NEW disposable MySQL 9.7.2 instance and a fresh uniquely named
`wmo_appointment_staging_*` database **for each selected case**. Use a new
loopback port other than 3306/33308. Manually apply only the three-table legacy
fixture. It must be empty; the runner generates its own synthetic seed rows.
No database/resource creation or fixture application is automated here.

Use local-only credentials supplied in the child process environment. The local
schema-scoped `wmo_appt_migration` account needs SELECT/INSERT/UPDATE, CREATE/ALTER,
REFERENCES, and a direct schema TRIGGER grant for complete trigger metadata.
`wmo_appt_migration_observer` needs SELECT on that schema only. No production
accounts, inherited URLs or credentials are accepted. Roles/global grants are
not used as substitutes for the explicit trigger-visibility check.

Required child-process environment (do not load .env):

    WMO_APPOINTMENT_MIGRATION_EXECUTE=I_AUTHORIZE_LOCAL_MIGRATION_DRY_RUN
    WMO_APPOINTMENT_MIGRATION_PROFILE=synthetic-legacy-v1-not-production-clone
    WMO_APPOINTMENT_MIGRATION_CASE=A
    WMO_APPOINTMENT_MIGRATION_HOST=127.0.0.1
    WMO_APPOINTMENT_MIGRATION_PORT=<new loopback port>
    WMO_APPOINTMENT_MIGRATION_DATABASE=wmo_appointment_staging_<unique_case_run>
    WMO_APPOINTMENT_MIGRATION_CONFIRM_EMPTY=<same exact schema>
    WMO_APPOINTMENT_MIGRATION_USER=wmo_appt_migration
    WMO_APPOINTMENT_MIGRATION_PASSWORD=<local-only secret>
    WMO_APPOINTMENT_MIGRATION_OBSERVER_USER=wmo_appt_migration_observer
    WMO_APPOINTMENT_MIGRATION_OBSERVER_PASSWORD=<local-only secret>

DATABASE_URL, MYSQL_URL, MYSQL_PWD, RESEND_API_KEY and the previous HTTP-suite
execution flag must be absent. Both connections must select the exact schema,
report MySQL 9.7.2, UTC effective session time and REPEATABLE-READ isolation.
Use locked dependencies from an independently approved installation; no package
or lockfile changes are needed.

    & 'C:\Users\ADMIN\Tools\wmo-node22-verified\node-v22.23.5-win-x64\node.exe' --test --test-concurrency=1 tests/appointmentMigrationDryRun.test.js

Run A, B, C, D, E, F_DDL, F_WRITE, F_UNCERTAIN, F_ATTEST, G, H and I, each against
its own fresh fixture. One selected real case executes per invocation; the other
real cases are intentionally skipped. A/C expect two conflicts, B one reservation,
D/G nine unready reservations, E/I nine verified ready reservations. Fault and
interference cases must never report readiness success. Preserve evidence and
the disposable data on failures; do not repair/replay automatically. Close pools
after each case. Resource cleanup requires exact ownership and separate scope;
this package deletes no data or resources.
