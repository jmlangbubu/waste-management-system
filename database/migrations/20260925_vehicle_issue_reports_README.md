# Vehicle Issue Reporting Phase 1 migration

This manual migration creates the `vehicle_issue_reports` table used by the
mobile Enforcer reporting API and the authorized Web Admin review API. It does
not alter Fleet, Dispatch, Tracking, Android, or existing report tables.

## Prerequisites

- Create and verify a restorable production logical backup before applying DDL.
- Use the production MySQL version and an account authorized for schema changes.
- Confirm these parent tables already exist: `fleet_trucks`, `users`,
  `dispatch_plans`, `dispatch_tickets`, `truck_tracking_sessions`, and
  `web_users`.
- Confirm the parent key types exactly match:

  - `fleet_trucks.id`: `INT UNSIGNED`
  - `users.id`: signed `INT`
  - `dispatch_plans.id`: `BIGINT UNSIGNED`
  - `dispatch_tickets.id`: `INT UNSIGNED`
  - `truck_tracking_sessions.id`: signed `INT`
  - `web_users.id`: signed `INT`

Do not run this migration through application startup. The application does
not create or modify this table automatically.

## Manual application

1. Verify the backup and parent key types in the target environment.
2. Review `20260925_vehicle_issue_reports.sql` against the target schema.
3. Apply that SQL once through the approved production migration process.
4. Do not seed or fabricate reports.
5. Deploy application code only after the table and constraints are verified.

## Validation queries

Run read-only validation after the approved migration:

```sql
SHOW CREATE TABLE vehicle_issue_reports;

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'vehicle_issue_reports'
ORDER BY ORDINAL_POSITION;

SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'vehicle_issue_reports'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'vehicle_issue_reports'
  AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY CONSTRAINT_NAME;

SELECT COUNT(*) AS vehicle_issue_report_count
FROM vehicle_issue_reports;
```

For a new Phase 1 deployment, the final count should be zero until a valid
Enforcer submits a report through the authenticated API.

## Rollback warning

`20260925_vehicle_issue_reports_rollback.sql` drops only the new table, but it
permanently removes every stored vehicle issue report, image reference, triage
assessment, review, and resolution record. Take and verify a fresh backup and
obtain explicit approval before rollback. The rollback does not change any
Fleet, Dispatch, Tracking, user, or notification table.

## Photo-storage note

Production image uploads require configured Cloudinary credentials. Local
filesystem fallback is available only outside production when
`VEHICLE_ISSUE_ALLOW_LOCAL_UPLOADS=true`; it is explicitly a development aid
and is not durable Render storage.
