# Phase 9 fleet and planning migration package

Status: **draft only; not applied**.

This package was prepared from backend base `07cc9ab450f21f151844e1decd7dc577c8698dac` on `codex/feature/fleet-planning-schema`. It follows the repository's reviewed-only `database/migrations` convention. No application startup code references or executes this migration.

## Files

- `20260828_phase9_fleet_planning.sql`: creates four empty Phase 9 tables.
- `20260828_phase9_fleet_planning_rollback.sql`: destructive, manual-only rollback.
- `20260828_phase9_wmo_truck_roster_template.csv`: header-only data-gathering template; it is not seed data.

## Locked live schema facts

The live Railway metadata was inspected read-only before this draft. Production reports MySQL Community Server 9.4.0. The foreign-key types in this package match the live physical types:

| Referenced column | Live type |
| --- | --- |
| `users.id` | signed `INT` |
| `web_users.id` | signed `INT` |
| `truck_tracking_sessions.id` | signed `INT` |
| `dispatch_tickets.id` | `INT UNSIGNED` |
| `dispatch_route_stops.id` | `INT UNSIGNED` |
| `gensan_dispatch_destinations.id` | `BIGINT UNSIGNED` |

The live `trucks` table is a legacy, empty table. It is not authoritative and this package does not rename, alter, drop, seed, or repurpose it. Phase 9 fleet records belong only in `fleet_trucks`. Deciding whether to retire the legacy table is a separate task.

## Fleet-state boundary

`fleet_trucks.fleet_condition` stores only persistent WMO condition:

- `available`
- `for_maintenance`
- `out_of_service`

Active dispatch, tracking state, and GPS freshness remain derived from the existing operational tables. They are not fleet conditions.

`truck_code` is the stable value later copied to existing string-based tracking and dispatch contracts. The table intentionally starts empty. In particular, historical labels `TRUCK-001`, `TRUCK-1`, and `TRUCK-9` are not seeded and are not assumed to be aliases.

## Conflict uniqueness

MySQL has no PostgreSQL-style partial unique index. `dispatch_plans` therefore has two stored generated columns:

- `conflict_truck_id` returns `fleet_truck_id` for `planned` or `activated` rows and `NULL` for cancelled rows.
- `conflict_enforcer_user_id` returns `assigned_enforcer_user_id` for `planned` or `activated` rows and `NULL` for cancelled rows.

Unique indexes on `(operational_date, conflict_truck_id)` and `(operational_date, conflict_enforcer_user_id)` reject a second non-cancelled truck or enforcer plan for the same day. MySQL permits multiple `NULL` values in a unique index, so a cancelled historical row does not block a replacement. Stored generated columns and indexes over them are supported by the verified production MySQL 9.4.0 engine.

Multiple-shift and automatic distribution rules remain out of scope. The current constraints intentionally reserve at most one plan per truck and one plan per enforcer for an operational date.

## Activation idempotency

The following nullable values are independently unique when present:

- `activation_action_id`
- `activated_tracking_session_id`
- `activated_dispatch_ticket_id`

This supports an idempotent activation transaction. The later service must lock and re-read the plan, verify `status = 'planned'`, validate WMO/session evidence, create or recover the linked operation, and persist all activation fields atomically. The schema alone does not implement that workflow.

## Foreign-key delete policy

- Fleet condition actor and fleet creator: `SET NULL`. These are optional audit actors and their removal must not delete a truck.
- Plan fleet-truck and assigned-enforcer references use `RESTRICT` on update and delete. Those identifiers are immutable operational keys, and MySQL does not permit cascading referential actions on base columns used by stored generated conflict columns.
- The required plan creator reference uses `RESTRICT` on delete so historical plans cannot lose its audit owner.
- Optional plan editor and canceller: `SET NULL`. Their removal preserves the plan and its snapshots.
- Activated tracking session and dispatch ticket: `RESTRICT`. Existing dispatch data is treated as operational evidence; deleting it must not silently erase the activation link. This also follows the live dispatch convention that ticket-linked operational evidence uses restrictive deletion.
- Plan stop parent: `CASCADE`. Stops have no independent meaning after an explicitly approved plan deletion.
- Optional catalog destination: `SET NULL`. Destination snapshots preserve the planned stop if the catalog row is removed.
- Mobile session user: `CASCADE`. Mobile sessions are revocable credentials rather than historical operations, and the current account route hard-deletes `users` rows.

The `RESTRICT` rules intentionally mean existing hard-delete account endpoints will fail while referenced historical plans exist. Application-level archival or deletion policy must be designed before Phase 9 plan APIs are enabled; weakening these FKs would silently damage auditability.

## Plate-number behavior

`plate_number` is nullable and has a normal MySQL unique key. MySQL permits multiple `NULL` values, while duplicate non-null plate numbers are rejected.

## Safe validation matrix

The migration must be applied only to a disposable MySQL schema before production approval. Validate:

1. A second `planned` or `activated` plan for the same truck/date is rejected.
2. A second `planned` or `activated` plan for the same enforcer/date is rejected.
3. After the old plan is cancelled, a replacement for the same truck/enforcer/date succeeds.
4. Duplicate non-null `activation_action_id`, tracking-session ID, or dispatch-ticket ID is rejected.
5. Duplicate `(dispatch_plan_id, stop_order)` is rejected.
6. Duplicate mobile token hashes are rejected.
7. Multiple null plate numbers succeed; duplicate non-null plates are rejected.
8. All FK signedness and referenced indexes match the live definitions.

On 2026-08-28, this package was executed against an isolated portable official MySQL Community Server 9.4.0 runtime bound only to localhost. The forward migration, the validation matrix above, the documented foreign-key delete actions, the rollback, and a second forward migration all passed. `SHOW CREATE TABLE` output for all four tables matched the reviewed schema. The disposable runtime and all synthetic test data were removed after validation; Railway was not used.

## Manual rollout outline — not authorized yet

1. Obtain and approve the authoritative WMO fleet roster and historical-label mapping.
2. Back up the intended database.
3. Confirm all four target tables are absent and recheck `SHOW CREATE TABLE` for referenced tables.
4. Apply this migration manually to a disposable schema and complete the validation matrix.
5. Review the resulting `SHOW CREATE TABLE` output.
6. Obtain separate approval before applying the migration to Railway.
7. Apply the migration before deploying code that depends on the new tables.
8. Load the approved WMO roster only through a separately reviewed and authorized process.

## Rollback

Rollback is destructive and manual-approval-only. Remove dependent tables in this order:

1. `dispatch_plan_stops`
2. `dispatch_plans`
3. `mobile_user_sessions`
4. `fleet_trucks`

Do not disable foreign-key checks. If a later schema references these tables, the rollback must stop and be redesigned.

## Later Daily Operations projection

Daily Operations is intentionally unchanged in this package. A later read model should use `fleet_trucks` as the complete roster and left-join date-filtered dispatch/tracking/GPS aggregates. `COALESCE` should project zero dispatches, zero distance, zero tracking time, and `No Operation` without creating fake tickets, sessions, or GPS rows. Historical activity whose string truck ID has no approved fleet mapping must remain visible as unmapped history rather than being silently discarded.

## Later mobile authentication contract

Android authentication is intentionally unchanged in this package. The approved future flow is:

1. Mobile login validates the account and creates a cryptographically random opaque token.
2. The backend stores only the token's SHA-256 hash in `mobile_user_sessions`.
3. Android stores the raw token using the safest storage available to the current app architecture.
4. Private assignment requests present the token.
5. The backend resolves and validates the current `users.id`, status, expiry, and revocation from the token.
6. A client-provided `user_id` is never authoritative.

The backend and Android changes require a separate review after this schema package is approved.
