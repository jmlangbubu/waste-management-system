# Appointment service slots — draft rollout contract

Nothing in this directory was executed. The SQL draft deliberately contains an invalid
type placeholder. It is a review artifact, not an approved migration.

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

Obtain separately authorized DDL/index/FK/trigger/engine evidence. Confirm the exact signed
type of appointments.id; preferred_date must retain a Philippine wall-clock date and time.
Confirm field lengths, status constraints, MySQL 8 `FOR SHARE` support and connection time-zone
permissions. Match FK types exactly; do not convert or rebuild existing tables automatically.
The draft adds no new staff roles and does not change certificates or Android.

## Non-destructive backfill plan

1. First obtain the disposable-MySQL and schema evidence described below. Freeze ALL writers
   during cutover: booking, acceptance/rejection, cancellation/rescheduling, QR generation,
   quiz, retake/incomplete, no-show reconciliation, legacy servers/clients and direct SQL.
   Stop old instances and drain in-flight requests/transactions; UI closure alone is insufficient.
2. Take an operator-approved backup/snapshot. An approved operator invalidates backfill
   readiness (zero) while writers remain frozen. No commands here perform that change.
   Resolve/review the ID placeholder and DDL, apply only separately approved schema, and deploy
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
reviewed; their live types and compatibility still require schema validation.

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
Live schema, backfill conflicts, migration execution and real concurrency are UNVERIFIED.
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
