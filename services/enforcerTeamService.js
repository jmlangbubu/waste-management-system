class EnforcerTeamError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function positiveId(value, label) {
  if (!/^[1-9]\d*$/.test(String(value ?? "")) || !Number.isSafeInteger(Number(value))) {
    throw new EnforcerTeamError(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function query(connection, sql, values = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function call(connection, method) {
  return new Promise((resolve, reject) => {
    connection[method]((error) => error ? reject(error) : resolve());
  });
}

function createEnforcerTeamService(db) {
  async function transaction(work) {
    const connection = await new Promise((resolve, reject) => {
      db.getConnection((error, conn) => error ? reject(error) : resolve(conn));
    });
    let discardConnection = false;
    try {
      await call(connection, "beginTransaction");
      const result = await work(connection);
      await call(connection, "commit");
      return result;
    } catch (error) {
      try { await call(connection, "rollback"); } catch {
        // Never return an uncertain transaction to the pool. Preserve the original error.
        discardConnection = true;
        connection.destroy();
      }
      throw error;
    } finally {
      if (!discardConnection) connection.release();
    }
  }

  async function validTeam(connection, value) {
    const id = positiveId(value, "Enforcer team ID");
    const teams = await query(connection,
      "SELECT id, team_name, status FROM enforcer_teams WHERE id = ? FOR UPDATE", [id]);
    if (!teams.length || teams[0].status !== "active") {
      throw new EnforcerTeamError("Select an existing active Enforcer team.");
    }
    const aors = await query(connection,
      "SELECT barangay_name FROM enforcer_team_aors WHERE team_id = ? ORDER BY sort_order, id FOR UPDATE", [id]);
    if (!aors.length) throw new EnforcerTeamError("The selected Enforcer team has no assigned AORs.");
    return { ...teams[0], aors: aors.map((aor) => aor.barangay_name) };
  }

  async function listTeams(teamId) {
    const where = teamId === undefined ? "WHERE status = ?" : "WHERE id = ?";
    const value = teamId === undefined ? "active" : positiveId(teamId, "Enforcer team ID");
    const teams = await query(db,
      `SELECT id, team_name, status, created_at, updated_at FROM enforcer_teams ${where} ORDER BY team_name, id`, [value]);
    if (!teams.length) {
      if (teamId !== undefined) throw new EnforcerTeamError("Enforcer team not found.", 404);
      return [];
    }
    const ids = teams.map((team) => team.id);
    const placeholders = ids.map(() => "?").join(", ");
    const aors = await query(db,
      `SELECT team_id, barangay_name FROM enforcer_team_aors WHERE team_id IN (${placeholders}) ORDER BY team_id, sort_order, id`, ids);
    const members = await query(db, `SELECT m.team_id, u.id, u.full_name, u.status
      FROM enforcer_team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id IN (${placeholders}) ORDER BY m.team_id, u.full_name, u.id`, ids);
    return teams.map((team) => ({ ...team,
      aors: aors.filter((aor) => Number(aor.team_id) === Number(team.id)).map((aor) => aor.barangay_name),
      members: members.filter((member) => Number(member.team_id) === Number(team.id)).map(({team_id, ...member}) => member)
    }));
  }

  async function createEnforcer(input) {
    positiveId(input.enforcer_team_id, "Enforcer team ID");
    return transaction(async (connection) => {
      const team = await validTeam(connection, input.enforcer_team_id);
      const duplicate = await query(connection, "SELECT id FROM users WHERE username = ? LIMIT 1", [input.username]);
      if (duplicate.length) throw new EnforcerTeamError("Username already exists", 409);
      // Legacy single-AOR compatibility. Team/AOR tables are the source of truth.
      // Remove/update when Android multi-AOR support is implemented.
      const compatibilityAor = team.aors[0];
      const result = await query(connection, `INSERT INTO users
        (full_name, username, password, role, mobile_role, assigned_source_name, barangay, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.full_name, input.username, input.hashedPassword, "enforcer", "enforcer", compatibilityAor, compatibilityAor, input.status]);
      await query(connection, "INSERT INTO enforcer_team_members (team_id, user_id) VALUES (?, ?)", [team.id, result.insertId]);
      return result.insertId;
    });
  }

  async function assignMember(teamId, userId) {
    const id = positiveId(userId, "Enforcer user ID");
    return transaction(async (connection) => {
      const team = await validTeam(connection, teamId);
      const users = await query(connection, "SELECT id, role, mobile_role FROM users WHERE id = ? FOR UPDATE", [id]);
      if (!users.length) throw new EnforcerTeamError("Enforcer account not found.", 404);
      if (String(users[0].mobile_role || users[0].role).toLowerCase() !== "enforcer") {
        throw new EnforcerTeamError("Only Enforcer accounts may join an Enforcer team.");
      }
      const memberships = await query(connection, "SELECT team_id FROM enforcer_team_members WHERE user_id = ? FOR UPDATE", [id]);
      if (memberships.length && Number(memberships[0].team_id) !== Number(team.id)) {
        throw new EnforcerTeamError("This Enforcer already belongs to another team.", 409);
      }
      if (!memberships.length) {
        await query(connection, "INSERT INTO enforcer_team_members (team_id, user_id) VALUES (?, ?)", [team.id, id]);
      }
      // Legacy single-AOR compatibility. Team/AOR tables are the source of truth.
      // Remove/update when Android multi-AOR support is implemented.
      await query(connection, "UPDATE users SET assigned_source_name = ?, barangay = ? WHERE id = ?", [team.aors[0], team.aors[0], id]);
      return {user_id: id, enforcer_team_id: team.id};
    });
  }

  async function enrichAccounts(accounts) {
    const enforcers = accounts.filter((account) =>
      account.account_source === "mobile" && String(account.mobile_role || account.role).toLowerCase() === "enforcer");
    if (!enforcers.length) return accounts;
    const ids = enforcers.map((account) => account.id);
    const rows = await query(db, `SELECT m.user_id, t.id AS enforcer_team_id, t.team_name AS enforcer_team_name, a.barangay_name
      FROM enforcer_team_members m JOIN enforcer_teams t ON t.id = m.team_id
      LEFT JOIN enforcer_team_aors a ON a.team_id = t.id
      WHERE m.user_id IN (${ids.map(() => "?").join(", ")}) ORDER BY m.user_id, a.sort_order, a.id`, ids);
    const byUser = new Map();
    for (const row of rows) {
      const key = Number(row.user_id);
      if (!byUser.has(key)) byUser.set(key, {enforcer_team_id: row.enforcer_team_id, enforcer_team_name: row.enforcer_team_name, enforcer_aors: []});
      if (row.barangay_name) byUser.get(key).enforcer_aors.push(row.barangay_name);
    }
    return accounts.map((account) => enforcers.includes(account) ? {...account,
      ...(byUser.get(Number(account.id)) || {enforcer_team_id: null, enforcer_team_name: null, enforcer_aors: []})
    } : account);
  }

  return {listTeams, createEnforcer, assignMember, enrichAccounts};
}

module.exports = {createEnforcerTeamService, EnforcerTeamError};
