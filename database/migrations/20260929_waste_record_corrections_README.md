# Validated Waste Record corrections migration

This is a manual migration, never run at application startup. It creates
request and append-only audit tables; it does not alter
`validated_waste_records` or `web_users`. Do not rerun it in Railway production.

## Railway production application — 2026-09-29

The user manually applied both `CREATE TABLE` statements to the Railway
production database on 2026-09-29. Post-migration read-only verification
reported that both `waste_record_correction_requests` and
`waste_record_correction_audit` exist, each uses InnoDB and
`utf8mb4_general_ci`, and their initial row counts were 0 and 0 respectively.
The live ID/reference types matched the reviewed SQL, all four JSON columns
were created successfully, and the audit `correction_request_id` is unique.
No validated Waste Record was modified by this migration. The rollback was
not executed. These are the user's reported production verification results;
this README does not trigger or repeat any database operation.

The application keeps `raw_payload` unchanged as the original submitted
evidence. The four corrected normalized subtotals and server-calculated
`grand_total`, together with the immutable before/after audit row, are the
authoritative official values after an approved correction is applied. The
Web breakdown labels raw detail as original submitted evidence.

Only the four normalized subtotal columns are editable in this phase.
Collection and period dates are excluded because the legacy submission/raw
payload and UI filters may mirror them. Other identity, validation, QR, and
signature fields are excluded.

Manual read-only verification of the target database reported MySQL 9.7.2,
JSON support (`JSON_VALID` returned 1), InnoDB for both existing tables, and
`utf8mb4_general_ci` for both existing tables. `validated_waste_records.id`
and `web_users.id` are `INT`. Accordingly, both new `waste_record_id` columns
and every existing-user ID reference use `INT`. The new request and audit
tables' own IDs remain `BIGINT UNSIGNED`; the audit table's
`correction_request_id` matches the new request ID as `BIGINT UNSIGNED`.
Both new tables use InnoDB, utf8mb4, and `utf8mb4_general_ci`, with JSON
snapshots retained.

Foreign keys remain intentionally deferred despite the verified compatible
types and engines: the existing record and Web Admin user deletion/lifecycle
policy is not fully established. Do not add `ON DELETE CASCADE` or another
automatic deletion behavior. The new tables use indexed IDs; application
transactions lock and verify the referenced validated row. The audit request
ID is unique, preventing a second audit entry for one correction request.

Request creation locks the validated record row before checking for an active
(`pending` or `approved`) request. This serializes application-created
requests for that record. `rejected`, `applied`, and `cancelled` requests remain historical
and do not block a new proposal. The same parent-row-first lock order is used
by apply. This assumes all correction writes use this application workflow.

The original requester or a Super Admin may cancel a pending or approved,
unapplied request with a mandatory reason. Cancellation is terminal, records
its actor and timestamp on the request row, and never changes the validated
record or creates an applied-value audit entry.

For any other environment, recheck its schema and backup/recovery procedure
against this compatibility evidence, then apply the SQL once through its
approved migration process before deploying the API/UI code there.
There is no automatic table creation, update, or delete endpoint for audit.

The migration creates `waste_record_correction_requests` first, then
`waste_record_correction_audit`. The companion
`20260929_waste_record_corrections_rollback.sql` drops them in reverse order.
Rollback is destructive: it permanently removes every correction request,
cancellation reason, and applied-value audit entry. It must never be run
automatically; require a verified backup and separate explicit approval.
