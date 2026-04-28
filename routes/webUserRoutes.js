const express = require("express");
const router = express.Router();
const db = require("../config/db");
const bcrypt = require("bcrypt");

console.log("webUserRoutes loaded");

/* =========================================
   CREATE WEB USER
========================================= */
router.post("/create", async (req, res) => {
    const {
        full_name,
        username,
        password,
        role,
        division_name,
        status,
        created_by
    } = req.body;

    if (!full_name || !username || !password || !role || !division_name) {
        return res.status(400).json({
            success: false,
            message: "Missing required fields"
        });
    }

    const checkSql = `SELECT id FROM web_users WHERE username = ? LIMIT 1`;

    db.query(checkSql, [username], async (checkErr, checkResults) => {
        if (checkErr) {
            console.error("create web user check error:", checkErr);
            return res.status(500).json({
                success: false,
                message: "Username check failed"
            });
        }

        if (checkResults.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Username already exists"
            });
        }

        try {
            const hashedPassword = await bcrypt.hash(password, 10);

            const insertSql = `
                INSERT INTO web_users
                (full_name, username, password, role, division_name, status, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;

            db.query(
                insertSql,
                [
                    full_name,
                    username,
                    hashedPassword,
                    role,
                    division_name,
                    status || "active",
                    created_by || null
                ],
                (err, result) => {
                    if (err) {
                        console.error("create web user insert error:", err);
                        return res.status(500).json({
                            success: false,
                            message: "Insert failed"
                        });
                    }

                    return res.status(201).json({
                        success: true,
                        message: "Web account created successfully",
                        insertedId: result.insertId
                    });
                }
            );
        } catch (hashErr) {
            console.error("create web user hash error:", hashErr);
            return res.status(500).json({
                success: false,
                message: "Password hashing failed"
            });
        }
    });
});

/* =========================================
   CREATE MOBILE ACCOUNT
========================================= */
router.post("/create-mobile-account", async (req, res) => {
    const {
        full_name,
        username,
        password,
        mobile_role,
        assigned_source_name,
        status
    } = req.body;

    if (!full_name || !username || !password || !mobile_role || !assigned_source_name) {
        return res.status(400).json({
            success: false,
            message: "Missing required fields"
        });
    }

    const checkSql = `SELECT id FROM users WHERE username = ? LIMIT 1`;

    db.query(checkSql, [username], async (checkErr, checkResults) => {
        if (checkErr) {
            console.error("create mobile account check error:", checkErr);
            return res.status(500).json({
                success: false,
                message: "Username check failed"
            });
        }

        if (checkResults.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Username already exists"
            });
        }

        try {
            const hashedPassword = await bcrypt.hash(password, 10);

            const roleValue = mobile_role;
            const barangayValue =
                mobile_role === "barangay" || mobile_role === "enforcer"
                    ? assigned_source_name
                    : null;

            const insertSql = `
                INSERT INTO users
                (full_name, username, password, role, mobile_role, assigned_source_name, barangay, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;

            db.query(
                insertSql,
                [
                    full_name,
                    username,
                    hashedPassword,
                    roleValue,
                    mobile_role,
                    assigned_source_name,
                    barangayValue,
                    status || "active"
                ],
                (err, result) => {
                    if (err) {
                        console.error("create mobile account insert error:", err);
                        return res.status(500).json({
                            success: false,
                            message: "Insert failed"
                        });
                    }

                    return res.status(201).json({
                        success: true,
                        message: "Mobile account created successfully",
                        insertedId: result.insertId
                    });
                }
            );
        } catch (hashErr) {
            console.error("create mobile account hash error:", hashErr);
            return res.status(500).json({
                success: false,
                message: "Password hashing failed"
            });
        }
    });
});

/* =========================================
   GET WEB USERS ONLY
========================================= */
router.get("/all", (req, res) => {
    const sql = `SELECT * FROM web_users ORDER BY id DESC`;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("get web users error:", err);
            return res.status(500).json({
                success: false,
                message: "Fetch failed"
            });
        }

        return res.json({
            success: true,
            users: results
        });
    });
});

/* =========================================
   GET ALL ACCOUNTS (WEB + MOBILE)
========================================= */
router.get("/all-accounts", (req, res) => {
    const webSql = `
        SELECT
            id,
            full_name,
            username,
            role,
            division_name,
            status,
            created_at,
            'web' AS account_source,
            NULL AS mobile_role,
            NULL AS assigned_source_name
        FROM web_users
    `;

    const mobileSql = `
        SELECT
            id,
            full_name,
            username,
            role,
            NULL AS division_name,
            status,
            created_at,
            'mobile' AS account_source,
            mobile_role,
            assigned_source_name
        FROM users
    `;

    db.query(webSql, (webErr, webResults) => {
        if (webErr) {
            console.error("get all accounts web error:", webErr);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch web accounts"
            });
        }

        db.query(mobileSql, (mobileErr, mobileResults) => {
            if (mobileErr) {
                console.error("get all accounts mobile error:", mobileErr);
                return res.status(500).json({
                    success: false,
                    message: "Failed to fetch mobile accounts"
                });
            }

            const accounts = [...webResults, ...mobileResults].sort((a, b) => {
                const dateA = new Date(a.created_at || 0).getTime();
                const dateB = new Date(b.created_at || 0).getTime();
                return dateB - dateA;
            });

            return res.json({
                success: true,
                accounts
            });
        });
    });
});

/* =========================================
   UPDATE WEB ACCOUNT STATUS
========================================= */
router.put("/update-status/:id", (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).json({
            success: false,
            message: "Status is required"
        });
    }

    const sql = `UPDATE web_users SET status = ? WHERE id = ?`;

    db.query(sql, [status, id], (err, result) => {
        if (err) {
            console.error("update web status error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to update web account status"
            });
        }

        if (!result || result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Web account not found or no changes made"
            });
        }

        return res.json({
            success: true,
            message: "Web account status updated successfully"
        });
    });
});

/* =========================================
   UPDATE MOBILE ACCOUNT STATUS
========================================= */
router.put("/update-mobile-status/:id", (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).json({
            success: false,
            message: "Status is required"
        });
    }

    const sql = `UPDATE users SET status = ? WHERE id = ?`;

    db.query(sql, [status, id], (err, result) => {
        if (err) {
            console.error("update mobile status error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to update mobile account status"
            });
        }

        if (!result || result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Mobile account not found or no changes made"
            });
        }

        return res.json({
            success: true,
            message: "Mobile account status updated successfully"
        });
    });
});

/* =========================================
   DELETE WEB ACCOUNT
========================================= */
router.delete("/delete/:id", (req, res) => {
    const { id } = req.params;

    const sql = `DELETE FROM web_users WHERE id = ?`;

    db.query(sql, [id], (err) => {
        if (err) {
            console.error("delete web account error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to delete web account"
            });
        }

        return res.json({
            success: true,
            message: "Web account deleted successfully"
        });
    });
});

/* =========================================
   DELETE MOBILE ACCOUNT
========================================= */
router.delete("/delete-mobile/:id", (req, res) => {
    const { id } = req.params;

    const sql = `DELETE FROM users WHERE id = ?`;

    db.query(sql, [id], (err) => {
        if (err) {
            console.error("delete mobile account error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to delete mobile account"
            });
        }

        return res.json({
            success: true,
            message: "Mobile account deleted successfully"
        });
    });
});

/* =========================================
   APPOINTMENTS - GET ACTIVE
   Pending lang ang lalabas dito
========================================= */
router.get("/appointments/active", (req, res) => {
    const sql = `
        SELECT
            id,
            full_name,
            barangay,
            contact,
            purpose,
            preferred_date,
            status,
            assigned_to,
            created_at,
            updated_at
        FROM appointments
        WHERE status IS NULL
           OR TRIM(status) = ''
           OR LOWER(status) = 'pending'
        ORDER BY preferred_date ASC, id DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("get active appointments error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch active appointments"
            });
        }

        return res.json({
            success: true,
            appointments: results
        });
    });
});

/* =========================================
   APPOINTMENTS - GET HISTORY
   Approved / Rejected mapupunta dito
========================================= */
router.get("/appointments/history", (req, res) => {
    const sql = `
        SELECT
            id,
            full_name,
            barangay,
            contact,
            purpose,
            preferred_date,
            status,
            assigned_to,
            created_at,
            updated_at
        FROM appointments
        WHERE LOWER(status) IN ('approved', 'rejected')
        ORDER BY updated_at DESC, id DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("get appointment history error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch appointment history"
            });
        }

        return res.json({
            success: true,
            history: results
        });
    });
});

/* =========================================
   APPOINTMENTS - ACCEPT / REJECT
   Kapag accept/reject, auto assign current admin
========================================= */
router.put("/appointments/:id/decision", (req, res) => {
    const { id } = req.params;
    const { action, personnel_name } = req.body;

    if (!id) {
        return res.status(400).json({
            success: false,
            message: "Appointment ID is required"
        });
    }

    if (!action || !["accept", "reject"].includes(String(action).toLowerCase())) {
        return res.status(400).json({
            success: false,
            message: "Invalid action. Use accept or reject"
        });
    }

    if (!personnel_name || !String(personnel_name).trim()) {
        return res.status(400).json({
            success: false,
            message: "Personnel name is required"
        });
    }

    const normalizedAction = String(action).toLowerCase();
    const newStatus = normalizedAction === "accept" ? "approved" : "rejected";
    const cleanPersonnelName = String(personnel_name).trim();

    const checkSql = `
        SELECT id, status
        FROM appointments
        WHERE id = ?
        LIMIT 1
    `;

    db.query(checkSql, [id], (checkErr, checkResults) => {
        if (checkErr) {
            console.error("check appointment before decision error:", checkErr);
            return res.status(500).json({
                success: false,
                message: "Failed to validate appointment"
            });
        }

        if (!checkResults || checkResults.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Appointment not found"
            });
        }

        const existingStatus = String(checkResults[0].status || "").toLowerCase().trim();

        if (existingStatus === "approved" || existingStatus === "rejected") {
            return res.status(400).json({
                success: false,
                message: "Appointment already processed"
            });
        }

        const updateSql = `
    UPDATE appointments
    SET
        status = ?,
        assigned_to = ?,
        updated_at = NOW()
    WHERE id = ?
`;

        db.query(updateSql, [newStatus, cleanPersonnelName, id], (updateErr, updateResult) => {
            if (updateErr) {
                console.error("appointment decision update error:", updateErr);
                return res.status(500).json({
                    success: false,
                    message: "Failed to update appointment decision"
                });
            }

            if (!updateResult || updateResult.affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Appointment not found or no changes made"
                });
            }

            return res.json({
                success: true,
                message:
                    newStatus === "approved"
                        ? "Appointment accepted successfully"
                        : "Appointment rejected successfully",
                data: {
                    id: Number(id),
                    status: newStatus,
                    assigned_personnel: cleanPersonnelName
                }
            });
        });
    });
});

/* =========================================
   UPDATE WEB ACCOUNT DETAILS
   username required, password optional
========================================= */
router.put("/update/:id", async (req, res) => {
    const { id } = req.params;
    const { username, password } = req.body;

    if (!username || !String(username).trim()) {
        return res.status(400).json({
            success: false,
            message: "Username is required"
        });
    }

    try {
        let sql = `UPDATE web_users SET username = ?`;
        const params = [String(username).trim()];

        if (password && String(password).trim()) {
            const hashedPassword = await bcrypt.hash(String(password).trim(), 10);
            sql += `, password = ?`;
            params.push(hashedPassword);
        }

        sql += ` WHERE id = ?`;
        params.push(id);

        db.query(sql, params, (err, result) => {
            if (err) {
                console.error("update web account error:", err);
                return res.status(500).json({
                    success: false,
                    message: "Failed to update web account"
                });
            }

            if (!result || result.affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Web account not found"
                });
            }

            return res.json({
                success: true,
                message: "Web account updated successfully"
            });
        });
    } catch (error) {
        console.error("update web account hash error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to process password"
        });
    }
});

/* =========================================
   UPDATE MOBILE ACCOUNT DETAILS
   username required, password optional
========================================= */
router.put("/update-mobile/:id", async (req, res) => {
    const { id } = req.params;
    const { username, password } = req.body;

    if (!username || !String(username).trim()) {
        return res.status(400).json({
            success: false,
            message: "Username is required"
        });
    }

    try {
        let sql = `UPDATE users SET username = ?`;
        const params = [String(username).trim()];

        if (password && String(password).trim()) {
            const hashedPassword = await bcrypt.hash(String(password).trim(), 10);
            sql += `, password = ?`;
            params.push(hashedPassword);
        }

        sql += ` WHERE id = ?`;
        params.push(id);

        db.query(sql, params, (err, result) => {
            if (err) {
                console.error("update mobile account error:", err);
                return res.status(500).json({
                    success: false,
                    message: "Failed to update mobile account"
                });
            }

            if (!result || result.affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Mobile account not found"
                });
            }

            return res.json({
                success: true,
                message: "Mobile account updated successfully"
            });
        });
    } catch (error) {
        console.error("update mobile account hash error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to process password"
        });
    }
});

module.exports = router;
