# Direct Enforcer AOR assignments — manual migration

Run only through a separately approved migration process after backup and runtime
validation. Never execute on application startup. No production execution is
authorized by this implementation task.

Verify `users.id` is signed INT, indexed PRIMARY KEY, and users uses InnoDB.
This matches the documented existing FK contract; production was not accessed.
Check existing tables/constraint names before running: IF NOT EXISTS does not
repair incompatible definitions. MySQL DDL implicitly commits; the seed
transaction does not make the complete migration atomic.

Creates only enforcer_aors and enforcer_user_aors, with 26 unique official
barangays and no user mappings. Repeat seeds preserve IDs and active/inactive
status. No historical team tables, memberships, or existing users are changed.
One user may have many AORs; UNIQUE(user_id, aor_id) blocks duplicate mappings.
Explicit user deletion cascades mappings; deleting an assigned AOR is restricted.

Apply before enabling the new creation UI/API. Missing direct-AOR tables fail
safely, not by silently creating unassigned Enforcers.
GET /api/web-users/enforcer-aors uses the existing users.manage and CSRF router.
Enforcer creation submits enforcer_aor_ids, validates all active IDs, and stores
user/mappings in one transaction. The first selected ID temporarily populates
users.barangay and users.assigned_source_name for legacy Android only.
All Accounts uses one batched direct-mapping query; users without direct mappings
keep the existing legacy single-AOR fallback. No automatic legacy migration.

Historical team endpoints/service remain intact. The current account editor
changes credentials only, not assignments. Editing/reassigning existing direct
AORs and Android multi-AOR support are separate follow-ups.
