# Enforcer Team/AOR foundation — manual migration

Do not run this migration from application startup. It has only been statically
validated; no Railway/production database was contacted or changed.

Before separately authorized execution, back up the database and verify MySQL
supports DATETIME(3), InnoDB, and that `users.id` is signed INT with an indexed
primary key (matching the existing Vehicle Issue migration). Check any existing
tables with these names against the complete definitions: `IF NOT EXISTS` does
not repair an incompatible table. DDL implicitly commits in MySQL; the seed
transaction does not make the whole migration atomic. Resolve any error before
continuing; do not suppress it.

Creates three normalized tables and seeds 12 neutral teams / 26 ordered AORs.
Re-running seeds does not reactivate teams or overwrite existing AOR ordering.
No users, memberships, or legacy user fields are changed by the migration.
The unique membership `user_id` guarantees one team per account; team deletion
is restricted, while explicit user deletion removes only that membership.

Apply before enabling the new API/UI. Missing tables will produce a safe API
error, not silent acceptance of single-barangay Enforcer creation.

Protected APIs under the existing `users.manage` + CSRF router:

- GET `/api/web-users/enforcer-teams`: active teams, ordered AORs, compact members.
- GET `/api/web-users/enforcer-teams/:id`: team including members/AORs.
- PUT `/api/web-users/enforcer-teams/:id/members/:userId`: explicit assignment of
  an existing Enforcer. Assignment to another team is rejected; repeated same-team
  assignment is idempotent. No guessed/automatic migration or reassignment UI.
- POST `/api/web-users/create-mobile-account`: Enforcer requires `enforcer_team_id`.

For creation/explicit assignment, users' single-AOR fields are updated to the
first ordered AOR solely for current Android compatibility. Team tables remain
the source of truth. Android multi-AOR responses/UI, team/AOR CRUD, membership
reassignment management, and manual legacy account migration are later phases.
