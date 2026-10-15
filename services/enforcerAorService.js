class EnforcerAorError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

function normalizeAorIds(value) {
  if (!Array.isArray(value) || !value.length) throw new EnforcerAorError("Select at least one AOR.");
  const ids = value.map(id => {
    if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) > 4294967295) {
      throw new EnforcerAorError("Every AOR ID must be a valid positive integer.");
    }
    return Number(id);
  });
  return [...new Set(ids)]; // Preserve first-selected order for the compatibility bridge.
}

const query = (db, sql, values = []) => new Promise((resolve, reject) =>
  db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
const call = (db, method) => new Promise((resolve, reject) =>
  db[method](error => error ? reject(error) : resolve()));

function createEnforcerAorService(db) {
  async function listAors() {
    return query(db, "SELECT id, barangay_name FROM enforcer_aors WHERE status = ? ORDER BY barangay_name, id", ["active"]);
  }

  async function createEnforcer(input) {
    const ids = normalizeAorIds(input.enforcer_aor_ids);
    const connection = await new Promise((resolve, reject) =>
      db.getConnection((error, conn) => error ? reject(error) : resolve(conn)));
    let discard = false;
    try {
      await call(connection, "beginTransaction");
      const aors = await query(connection, `SELECT id, barangay_name FROM enforcer_aors
        WHERE id IN (${ids.map(() => "?").join(", ")}) AND status = ? ORDER BY id FOR UPDATE`, [...ids, "active"]);
      if (aors.length !== ids.length) throw new EnforcerAorError("Select existing active AORs only.");
      const duplicate = await query(connection, "SELECT id FROM users WHERE username = ? LIMIT 1", [input.username]);
      if (duplicate.length) throw new EnforcerAorError("Username already exists", 409);
      // Temporary Android single-AOR compatibility only. Direct mappings are authoritative.
      // Preserve the first selected AOR until Android supports the complete assignment array.
      const firstAor = aors.find(aor => Number(aor.id) === ids[0]).barangay_name;
      const user = await query(connection, `INSERT INTO users
        (full_name, username, password, role, mobile_role, assigned_source_name, barangay, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.full_name, input.username, input.hashedPassword, "enforcer", "enforcer", firstAor, firstAor, input.status]);
      for (const id of ids) {
        await query(connection, "INSERT INTO enforcer_user_aors (user_id, aor_id) VALUES (?, ?)", [user.insertId, id]);
      }
      await call(connection, "commit");
      return user.insertId;
    } catch (error) {
      try { await call(connection, "rollback"); } catch { discard = true; connection.destroy(); }
      throw error;
    } finally { if (!discard) connection.release(); }
  }

  async function enrichAccounts(accounts) {
    const ids = accounts.filter(user => user.account_source === "mobile" &&
      String(user.mobile_role || user.role).toLowerCase() === "enforcer").map(user => user.id);
    if (!ids.length) return accounts;
    const rows = await query(db, `SELECT m.user_id, a.id AS aor_id, a.barangay_name
      FROM enforcer_user_aors m JOIN enforcer_aors a ON a.id = m.aor_id
      WHERE m.user_id IN (${ids.map(() => "?").join(", ")}) ORDER BY m.user_id, m.id`, ids);
    const assignments = new Map();
    for (const row of rows) {
      if (!assignments.has(Number(row.user_id))) assignments.set(Number(row.user_id), []);
      assignments.get(Number(row.user_id)).push(row);
    }
    return accounts.map(user => user.account_source === "mobile" && ids.includes(user.id) ? {...user,
      enforcer_aor_ids: (assignments.get(Number(user.id)) || []).map(row => row.aor_id),
      enforcer_aors: (assignments.get(Number(user.id)) || []).map(row => row.barangay_name)
    } : user);
  }
  return {listAors, createEnforcer, enrichAccounts};
}
module.exports = {createEnforcerAorService, EnforcerAorError, normalizeAorIds};
