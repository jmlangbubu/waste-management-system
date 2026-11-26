# Appointment service slots — draft rollout contract

Nothing in this directory was executed. Every SQL statement in the draft remains commented
out. The reviewed signed appointment ID type is recorded below, but the file remains a
review artifact, not an executable or approved migration.

## Current gate

New booking and availability return HTTP 503 unless `APPOINTMENT_RESERVATIONS_ENABLED`
is exactly `true`, the version-1 readiness marker attests complete backfill, required tables
are InnoDB, unique keys and appointment foreign keys exist, and the revision column exists.
There is no unchecked booking fallback. Do not enable or deploy this implementation yet.
ALL appointment mutations require the verified reservation protocol, including approval,
rejection, cancellation, rescheduling, QR generation, quiz start/completion, retake and
incomplete actions. An off flag returns 503; it never selects a non-reservation writer.
It is impossible to prove "never activated" from an off environment flag or a missing table
(which may instead mean lost permissions or damaged/incomplete infrastructure). No legacy
write exception is allowed. This deliberately closes writes before initial activation too.
Read-only staff views may remain available in maintenance; they do not perform no-show
reconciliation while disabled. Enabled no-show reconciliation verifies readiness and advances
revisions. Public booking/tracking/token operations remain session-free; write availability
and reference recovery depend on verified infrastructure. Tracking itself remains accessible.

Operational impact: deploying before approved schema/backfill and uniform activation stops
public booking AND staff/orientation mutations. Do not deploy this as a routine rolling
release. The flag is a maintenance control, not evidence that the database is consistent.
Schema/backfill attestation is independently required; runtime checks cannot prove data
backfill completeness or detect every out-of-band writer.

## Required evidence before approval

The reviewed Q4 column export contains 23 appointments columns and eight notifications columns:

- appointments.id is signed INT, primary key, AUTO_INCREMENT. The draft therefore uses
  INT NOT NULL for appointment_reservations.appointment_id and INT NULL for
  appointment_booking_requests.appointment_id. Child IDs do not inherit AUTO_INCREMENT.
- appointments.appointment_code is nullable VARCHAR(30), marked unique. The proposed request
  copy is VARCHAR(30) NULL. Booking inserts the appointment before assigning its reference,
  and inserts request hashes before linking the appointment; preserve both nullable references.
- appointments.contact_number is VARCHAR(50) NOT NULL; contact is absent. Legacy list SQL
  reads contact_number AS contact to preserve the existing response property.
- preferred_date is nullable DATETIME(0); appointment_revision is absent. Preserve existing
  appointment columns and propose only the additive BIGINT UNSIGNED NOT NULL DEFAULT 0 revision.
- Notification column names include isRead and createdAt. Do not rename them. The existing
  booking insert supplies type, title and message; exact withheld default expressions still
  require review.

The owner reports MySQL 9.7.2, InnoDB appointments/notifications, and an existing
orientation_quiz_results foreign key to appointments.id. Preserve that relationship and the
parent ID without rebuilding either. Both proposed child FKs retain ON DELETE RESTRICT and
document ON UPDATE RESTRICT. Required unique reservation-slot, reservation-appointment,
request-hash and request-appointment keys remain in the draft. Initial backfill_complete stays 0.

The three reservation infrastructure tables were not reported in the reviewed inventory;
that alone does not prove absence if metadata visibility is uncertain. The Q4 export does not
establish engines, complete indexes, FK actions or triggers. The prior metadata screenshots
were unavailable for independent inspection during this patch. Full schema compatibility and
production deployment parity remain UNVERIFIED; the reported version is not migration approval.

Obtain separately authorized complete DDL/index/FK/trigger/engine evidence, including the
orientation child-table FK columns/actions. preferred_date must retain a Philippine wall-clock
date and time. Verify defaults, status constraints, MySQL 9.7.2 locking-read behavior and
connection time-zone permissions in disposable tests. Match FK types exactly; do not convert
or rebuild existing tables automatically. No migration, backfill or feature activation is
performed by this patch; APPOINTMENT_RESERVATIONS_ENABLED must not be enabled by these changes.
The draft adds no new staff roles and does not change certificates or Android.

## R2 runtime schema-readiness contract

R2 validates existing metadata only. It executes no DDL, repairs no schema, inserts no
feature marker, performs no backfill and never changes APPOINTMENT_RESERVATIONS_ENABLED.
The commented draft remains unchanged, including its initial backfill_complete = 0.
Runtime approval still requires exactly one case-exact service_slots marker, schema_version
1 and backfill_complete 1. Schema validity does not independently establish that backfill
was complete, and this patch is not permission to attest production readiness.

All five named objects must be exact BASE TABLE identities in the selected connection's
schema and use InnoDB. Required columns are matched by exact name, not LIKE patterns.
Structured metadata must expose type, signedness, nullability, applicable lengths/precision,
defaults, EXTRA and generation information. Missing/duplicate/ambiguous rows and query errors
produce the existing safe unavailable response without exposing schema or driver details.

Accepted required definitions:

- appointments: signed INT NOT NULL AUTO_INCREMENT primary id; nullable VARCHAR(30) code
  with full uniqueness; BIGINT UNSIGNED NOT NULL DEFAULT 0 revision; nullable DATETIME(0)
  preferred_date and orientation start/completion fields. Booking text remains VARCHAR with
  at least the existing policy capacities (name 150, barangay 100, contact 11, email 254,
  purpose 100), and notes TEXT with capacity for 2000 characters. Existing status, assignment,
  timestamp, QR, token and score columns must retain compatible types/nullability/capacities.
- reservations: service_key VARCHAR(32) ASCII/ascii_bin NOT NULL; DATE and TIME(0) NOT NULL;
  signed INT NOT NULL appointment_id. Require full unique (service_key, appointment_date,
  appointment_time) in that order and full unique (appointment_id).
- booking requests: request_hash and payload_hash CHAR(64) ASCII/ascii_bin NOT NULL;
  request_hash primary key; signed INT NULL appointment_id with full uniqueness;
  VARCHAR(30) NULL appointment_code. Both initial references must default to NULL.
- feature state: feature_key VARCHAR(32) ASCII/ascii_bin NOT NULL primary key;
  signed INT NOT NULL schema_version; signed TINYINT NOT NULL DEFAULT 0 backfill_complete.
- notifications: preserve id/type/title/message/isRead/createdAt/status/reference_id names.
  Require the reviewed compatible column shapes and an auto-generated id. The omitted
  createdAt timestamp must have an exposed CURRENT_TIMESTAMP default; isRead defaults to 0.

The insertion protocol also requires NULL defaults for initial appointment references,
assignment evidence and orientation date/score evidence. The omitted orientation_status
default must be NULL, blank, or normalize to approved, matching the existing scheduling
guard; a default inventing progress is rejected. The historical export withheld its value:
the synthetic fixture's approved default is NOT a claim about production. Status/QR defaults
that booking explicitly overrides are not treated as recovered historical facts.
Automatic timestamp updates are allowed on updated_at only among the required columns;
they must not invent orientation, assignment or creation history during later updates.

Every omitted required/extra column is checked for insert compatibility. Nullable NULL
defaults, compatible literal defaults, integer auto-generation and recognized current-time
defaults are supported. Unknown expression defaults or generated-column extensions fail
closed pending separate review. Metadata cannot prove arbitrary trigger/expression behavior.
Legacy columns are never altered or narrowed to satisfy this contract.

Index inspection checks complete groups, uniqueness, contiguous ordinals, column names,
full versus prefix lengths and functional parts. Primary keys on appointment id, request
hash and feature key are mandatory. Truncated/functional substitutes are rejected. Extra
nonunique indexes are allowed; an extra unique index is accepted when a full existing
unique determinant makes it redundant (including nullable keys), or an omitted integer
AUTO_INCREMENT generator makes it nonrestrictive. The notification INSERT-only protocol
also permits a full, nonfunctional extra unique key with an actual key column that is
omitted, nullable, defaults to SQL NULL and has empty EXTRA/GENERATION_EXPRESSION metadata.
The service inserts only type/title/message and never updates notifications; re-audit this
exception if those writes change. Nullability alone, non-NULL defaults, generated values,
prefix/functional keys and initially NULL appointment fields populated by later actions
do not establish this exception. Required keys are still checked independently.
Additional uniqueness on date/time alone,
citizen contact or repeated notification fields is rejected. Invisible unique indexes still
enforce uniqueness and are not discarded merely because of visibility.

Both new child FKs must be complete single-column signed-INT links to appointments.id in
the same selected schema. Verify source/target identities, positions and update/delete
actions through KEY_COLUMN_USAGE and REFERENTIAL_CONSTRAINTS. RESTRICT and NO ACTION are
accepted because all five tables must be InnoDB, where these actions are equivalent.
CASCADE, SET NULL, wrong targets/schemas, partial/composite substitutes and inaccessible
actions are rejected. No existing orientation FK is modified.

Connection and cost boundaries:

- Feature OFF is checked before acquiring a connection. A mutation leases once and validates
  that intended connection before timezone setup/BEGIN, then retains the locked marker
  recheck after BEGIN. R1 rollback, uncertain-commit and terminal cleanup rules remain intact.
- Standalone ready() leases once. Availability validates and reads reservations on that same
  lease. Valid read-only checks release; failed checks conservatively destroy, once only.
- Each successful readiness scan uses six read-only queries: selected-schema identity,
  TABLES, COLUMNS, STATISTICS, complete FK metadata and the unlocked marker. There is no
  metadata cache. Mutations additionally retain the locked marker query.
- Existing route guard chains can call ready() repeatedly. For example, enabled GET /active
  performs two sequential scans (12 metadata queries/two sequential leases); booking,
  availability and GET /orientation each perform one scan in the measured synthetic routes.
  No operation nests simultaneous leases. QR image retrieval remains an authorized existing
  maintenance read without a reservation dependency; no production route was changed.
- Offline tests measure model query/connection counts and local validation overhead, not
  MySQL network, data-dictionary contention or fleet-scale latency. Benchmark the actual
  approved MySQL build in a separately authorized disposable environment before rollout.

INFORMATION_SCHEMA is privilege-filtered. Required visible evidence must be complete, but
the validator cannot establish the absence of all hidden extra objects or certify grants.
Full metadata visibility, remaining DDL/default/trigger evidence and production parity need
independent operator verification. No privileges are obtained or changed by the validator.
One connection is not an atomic DDL snapshot: concurrent DDL/out-of-band writers remain
outside this guarantee. External writer freeze and drain remain mandatory for cutover and
attestation changes, especially for route-level orientation writes outside the transaction
wrapper. R2 introduces no timeout policy or schema cache; the separate R3 time contract is below.
Residual findings remain: readiness exceptions have no diagnostic classification, and
rejected readiness conservatively destroys potentially healthy connections. This nullable
index correction changes neither behavior; real database/load verification remains required.

## R3 Philippine calendar and orientation DATETIME contract

The appointment router captures one valid application Date instant at its first calendar
operation. It uses the unchanged appointmentPolicy.manilaNow() formatter (Asia/Manila),
then validates the YYYY-MM-DD portion with the existing policy validator. The frozen
date/timestamp snapshot is stored under a private request Symbol. It is reused throughout
that request, never returned in API responses, and refreshed for the next request. There
is no global date cache or extra database query for the clock. An invalid application
clock returns safe unavailability before calendar SQL.

Three former CURDATE() predicates now bind the Philippine date as a query parameter:

- No-show reconciliation: preferred_date < ?.
- GET /active: preferred_date >= ?.
- GET /history: preferred_date < ?.

The boundary is the Philippine calendar day, not a rolling 24-hour interval. Reconciliation
and the following list query share the same date even across midnight. Maintenance reads
also capture/bind that date while skipping reconciliation; disabled orientation mutations
remain denied by the existing readiness guards. Existing status/exclusion rules and
revision increments remain unchanged. Legacy web-user list routes are unchanged.

The same request snapshot supplies explicit YYYY-MM-DD HH:mm:ss Philippine strings for
orientation_started_at = COALESCE(orientation_started_at, ?) on start, and for
orientation_completed_at = ? on Mark Incomplete and a passed quiz. These nullable DATETIME(0)
fields no longer obtain their new values from the pooled session's NOW(). A failed quiz
still sets completion time to NULL. COALESCE retains an existing start time; idempotent
completed/failed/incomplete responses issue no second result UPDATE and preserve their
stored time, score and revision. Existing state guards, scoring and certificate eligibility
are preserved. All new dates/timestamps are bound values, with IDs/scores/tokens following
their unchanged SQL guards.

The seven unrelated updated_at = NOW() expressions, token generation, and existing
created_at/assigned_at/TIMESTAMP conventions are preserved. R3 makes no global application
or database timezone changes, session timezone mutations, timezone-table dependencies,
historical timestamp conversion, migration, backfill or activation. Existing historical
DATETIME values remain unverified and are retained rather than repaired automatically.

Offline tests cover UTC instants 2026-11-20T15:59:59Z, 16:00:00Z and 16:00:01Z, corresponding
to Manila 23:59:59 on November 20, then 00:00:00 and 00:00:01 on November 21. The route VM's
clock is isolated from the test host; the SQL model independently controls its session
calendar/NOW values. Tests cover midnight-crossing requests, lifecycle exclusions,
parameter order, COALESCE, idempotency, maintenance and authorization/readiness denial.
These are synthetic SQL tests. Actual MySQL DATETIME comparison/binding, preserved
TIMESTAMP behavior, historical encoding, concurrency, production parity and all existing
metadata/backfill/freeze/drain/deployment approvals remain separate rollout gates.

## Non-destructive backfill plan

1. First obtain the disposable-MySQL and schema evidence described below. Freeze ALL writers
   during cutover: booking, acceptance/rejection, cancellation/rescheduling, QR generation,
   quiz, retake/incomplete, no-show reconciliation, legacy servers/clients and direct SQL.
   Stop old instances and drain in-flight requests/transactions; UI closure alone is insufficient.
2. Take an operator-approved backup/snapshot. An approved operator invalidates backfill
   readiness (zero) while writers remain frozen. No commands here perform that change.
   Review the resolved signed-INT child definitions and DDL, apply only separately approved schema, and deploy
   a uniform reservation-aware fleet with its flag disabled BEFORE backfilling/reopening.
3. Inventory every capacity-consuming appointment: pending, approved, rescheduled. Normalize
   status using trim + lowercase, with null/empty/whitespace defaulting to pending, matching
   the application. Keep the original raw value for conditional comparisons; do not rewrite
   history automatically. Unknown or terminal statuses must never become pending. Unsupported
   values require manual classification. Parse dates as Philippine wall-clock strings, not UTC.
4. Map exact purpose strings to orientation/accreditation/iec_resource_speaker/others. All
   Others notes map to the same key. Reject unknown service/time/date mappings for review.
5. Produce a conflict report grouped by service/date/time, listing appointment IDs privately.
   Missing fields, unsupported legacy times, duplicate active claims and orphan relationships
   BLOCK activation. Do not delete, cancel or overwrite records to resolve them automatically.
6. Insert exactly one reservation for EVERY pending, approved and rescheduled record in the
   reviewed capacity inventory, including eligible normalized legacy pending values. Preserve
   rejected/cancelled historical appointments and their references WITHOUT active reservations.
   Preserve all history/reference codes and initialize monotonic revisions. Independently
   reconcile counts per normalized status AND per service, exact service/date/time keys,
   one-to-one appointment/reservation relationships, missing/orphan reservations and exclusions.
   Every discrepancy blocks readiness; do not resolve duplicates by automatic deletion.
7. Preserve existing reservations for orientation no-shows and completed orientation until release
   policy is confirmed. They remain unavailable; elapsed times are independently rejected.
   No-show reconciliation and quiz completion advance revisions without changing reservation
   release semantics. Terminal historical records need no newly invented booking capacity.
8. Verify ALL deployed writers participate in the same reservation/revision protocol. Old
   web/mobile/legacy server versions may not write during activation. Direct SQL writers
   require explicit operational controls; uniqueness alone cannot stop bypassed writers.
9. Run separately authorized disposable-MySQL concurrency, readiness invalidation and rollback
   tests, plus browser, staff-role, notification, email and orientation regressions. Verify
   Philippine date boundaries for pooled CURDATE()/NOW() reads as well as service transactions.
   Reconcile again while writes remain frozen. Only then separately approve readiness
   attestation, enable the entire compatible fleet, verify and reopen writers. Neither
   activation is performed by this implementation; mixed old/new writer fleets are unsafe.

## Idempotency and transaction contract

The browser retains a random request key and unchanged in-memory payload on uncertain results.
Session storage retains only the opaque key for this tab's reload recovery, never contact
details or the payload. After reload the citizen must re-enter the original details. A SHA-256
key and normalized payload hash are stored server-side. The request row, appointment, APT reference,
unique reservation and WMO notification commit together. Duplicate keys wait on the database
constraint and return the original reference; different payloads with the same key return 409.
Do not purge idempotency rows until an approved retry/retention policy exists. No PII goes
into availability responses. A same-slot collision is 409; infrastructure failures are 503.
No automatic mutation/deadlock retries are performed. An uncertain commit must be recovered
with the original key, not a new request. Notifications are transactional; reschedule emails
are attempted after commit and provider failures never roll back a committed schedule.

Recovery reuses POST /api/appointments with the original Idempotency-Key and the explicit
Idempotency-Recovery: true header. It performs only a locked lookup, verifies the normalized
payload hash and returns the original reference; it never inserts a request, appointment,
reservation or notification. It permits elapsed original dates and does not query availability.
Missing keys return 404 BOOKING_NOT_FOUND, mismatching payloads return 409, unverified
infrastructure returns 503. None clears the original recovery key or discloses stored PII.
If the initial request never reached the server, recovery does NOT submit it implicitly:
the citizen must retry recovery or contact WMO to resolve the uncertain outcome. No automatic
switch to a new booking/key is provided. Successful acknowledgement removes the stored key.

## Acceptance attribution and orientation boundaries

For requests processed by this workflow, assigned_to and assigned_at represent the LATEST
ACTUAL approval, not the most recent action. Only accept writes them. Rescheduling, rejection
and cancellation preserve them; a subsequent genuine reapproval updates them to that approver.
An appointment rejected/cancelled before any acceptance gains no fabricated accepting identity.
The unchanged Assigned Personnel report column uses this value. Historical values may already
have been overwritten by older writers; they remain unverified and are never reconstructed.
action_by in mutation responses identifies the authenticated current actor but is not a
durable action history. Existing appointment-specific uses of assigned_to/assigned_at were
reviewed; Q4 reports nullable assigned_to VARCHAR(255) and assigned_at TIMESTAMP(0).
Historical attribution and runtime compatibility remain unverified.

BLOCKED separate persistence proposal (not executable SQL, no schema change in this patch):
an append-only appointment action table containing appointment_id (exact verified ID type),
action, actor_user_id (verified web-user ID type), actor-name snapshot, acted_at and before/after
status/schedule/revision. Capture future actions in the same appointment transaction. Index
appointment/time; review retention, foreign keys and deletion policy separately. Do not
backfill unknown accepting identities. This is needed for durable later-action attribution
and multi-approval history; historical acceptance may be irrecoverable without external evidence.

An unstarted orientation can be rescheduled and reapproved with its existing token. Started,
failed, no-show, retake-ready, completed or incomplete evidence blocks ordinary rescheduling
before reservation/status/revision changes. Terminal appointment statuses remain terminal.
No quiz evidence is reset and no email is sent for a blocked reschedule.

## Limitations and rollback

Mock tests validate code paths, not actual InnoDB locking or production compatibility.
Q4 column metadata was reviewed; complete live schema, backfill conflicts, migration execution
and real concurrency remain UNVERIFIED.
During failure, freeze ALL writers listed above and drain requests before operator-approved
readiness invalidation. Keep the flag off across every instance. The service rechecks the
readiness row under a shared transaction lock, so invalidation must wait for running protocol
transactions. Route-level orientation writes also require readiness; because these are not
one shared transaction, the external freeze/drain is mandatory before changing attestation.
Preserve all tables/data and reconcile appointments, reservations, revisions, idempotency
references and notification outcomes, including uncertain commits. Repair only through an
approved recovery procedure, independently reconcile again, then explicitly reattest and
uniformly enable. Never restore readiness merely because the flag was switched back on.
Rollback to a version that ignores reservations may serve read-only traffic only while all
writes remain externally blocked. Never DROP reservation/history/idempotency tables as an
automatic rollback; never expose an older unprotected writer alongside the new application.

Separate, NOT FIXED security workstreams: certificate authentication/ownership/PII exposure;
orientation bearer tokens in raw request URLs/logs; cryptographically random future token
issuance while retaining existing legitimate tokens and Android/QR contracts. A narrowly
scoped logger proposal is to redact token path segments on orientation verify/start/complete
and token-bearing query parameters before logging, with captured-log regression tests.
No logger, token format, certificate code or production configuration is changed here.
