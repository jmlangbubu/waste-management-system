-- DESTRUCTIVE Phase 9 rollback.
-- MANUAL APPROVAL REQUIRED. DO NOT RUN AUTOMATICALLY.
--
-- Roll back application code before dropping these tables. MySQL DDL commits
-- implicitly, so verify each table is safe to remove before execution.

DROP TABLE IF EXISTS dispatch_plan_stops;
DROP TABLE IF EXISTS dispatch_plans;
DROP TABLE IF EXISTS mobile_user_sessions;
DROP TABLE IF EXISTS fleet_trucks;
