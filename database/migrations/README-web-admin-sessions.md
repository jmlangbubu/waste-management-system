# Web Admin session migration

This migration adds the server-side session store used by the Web Admin login. It is reviewed-only SQL: application startup never creates or alters the table.

## Live migration status

The migration was manually applied to Railway and postflight-verified on 2026-08-12. The reviewed columns and indexes matched this migration, and `SELECT COUNT(*) AS active_session_rows FROM web_admin_sessions` returned `0` immediately after migration. No connection details or credentials are recorded here.

## Safe production rollout order

1. Keep the trip-monitoring feature flag `FALSE`.
2. Back up the Railway MySQL database.
3. Review `create-web-admin-sessions.sql` against the confirmed live `web_users` ID, status, and role contract.
4. Confirm `web_admin_sessions.user_id` remains a signed `INT`, matching `web_users.id`.
5. Run the migration manually against the intended Railway database.
6. Confirm the table, unique token-hash constraint, and supporting indexes exist.
7. Configure `WEB_ADMIN_SESSION_TTL_SECONDS` if the default eight-hour absolute lifetime is not desired.
8. Deploy the backend and frontend session-auth code together.
9. Expect existing browser logins to sign in again; old `localStorage` identity is not authoritative.
10. Verify login creates an HttpOnly session cookie and a readable CSRF cookie with the required production attributes.
11. Verify `GET /api/web-auth/session` returns the current safe user.
12. Verify unauthenticated protected calls return `401` and wrong-role calls return `403`.
13. Verify invalid CSRF tokens block mutations.
14. Verify Admin User Management and WMO dispatch/tracking access against the role matrix.
15. Keep the trip-monitoring feature flag `FALSE` until all authentication validation passes.
16. Only then return to the isolated trip-monitoring branch for its separate review and integration.

Deploying the application before the migration is intentionally fail-closed: login cannot create a session and protected APIs return a controlled `503` response. Existing Android/mobile authentication and tracking writes do not use this table.

## Design notes

- Browser cookies contain the random session and CSRF tokens. Only SHA-256 hashes are stored in MySQL.
- Sessions have an absolute expiry. Updating `last_seen_at` does not extend `expires_at`.
- Logout and account-security changes set `revoked_at`; expired rows can be marked revoked with the service cleanup method. No cleanup SQL is run automatically at startup.
- The live Railway contract was manually confirmed as `web_users.id INT` signed, `NOT NULL`, `AUTO_INCREMENT`. The session table therefore uses `user_id INT NOT NULL`.
- Current live Web Admin roles are `super_admin`, `division_admin`, `personnel`, `supervisor`, and `clerk_admin`; account status is `VARCHAR(50) NOT NULL DEFAULT 'active'` and all current accounts use `active`.
- This migration deliberately does not add a foreign key. The repository contains hard-delete behavior for `web_users`, but it does not prove a safe database-level cascade/restrict policy or deletion order for session rows. Every protected request instead joins the current `web_users` row and requires normalized `status = 'active'`.

## Manual migration verification

Run this pre-migration check manually against the intended Railway schema:

```sql
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME = 'web_admin_sessions';
```

Expected current result: `0 rows`.

After manually applying `create-web-admin-sessions.sql`, run:

```sql
SHOW CREATE TABLE web_admin_sessions;

SELECT
    COLUMN_NAME,
    COLUMN_TYPE,
    IS_NULLABLE,
    COLUMN_DEFAULT,
    EXTRA
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME = 'web_admin_sessions'
ORDER BY ORDINAL_POSITION;

SELECT
    INDEX_NAME,
    NON_UNIQUE,
    SEQ_IN_INDEX,
    COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME = 'web_admin_sessions'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

SELECT COUNT(*) AS active_session_rows
FROM web_admin_sessions;
```

Expected immediately after migration: `0` session rows.

## Rollback

Roll back the application before removing the table. Dropping the table immediately invalidates all Web Admin sessions and makes protected Web Admin APIs fail closed. Do not drop it while the session-auth application version is running.
