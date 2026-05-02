const express = require("express");
const router = express.Router();
const db = require("../config/db");

/* =========================================================
   HELPERS
========================================================= */

const VALID_INVOICE_STATUSES = [
  "sent_to_clerk",
  "accepted_by_clerk",
  "sent_to_supervisor",
  "assigned_to_division",
  "accepted_by_division",
  "returned_to_clerk",
  "completed"
];

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeRole(role) {
  return cleanText(role).toLowerCase().replace(/\s+/g, "_");
}

function isHeadAdmin(role) {
  return ["super_admin", "head_admin", "admin"].includes(normalizeRole(role));
}

function sendError(res, status, message, error = null) {
  if (error) console.error(message, error);
  return res.status(status).json({
    success: false,
    message
  });
}

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

async function getWebUserById(userId) {
  const rows = await query(
    `
      SELECT id, full_name, username, role, division_name, status
      FROM web_users
      WHERE id = ?
      LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

async function requireWebUser(res, userId) {
  if (!userId) {
    sendError(res, 400, "Missing user_id.");
    return null;
  }

  const user = await getWebUserById(userId);

  if (!user) {
    sendError(res, 404, "User account not found.");
    return null;
  }

  return user;
}

async function createTrackingLog({
  invoiceId,
  trackingNo,
  actionType,
  message,
  actionBy,
  actionByRole,
  actionTo = null,
  actionToRole = null,
  remarks = null
}) {
  await query(
    `
      INSERT INTO invoice_tracking_logs
      (invoice_id, tracking_no, action_type, message, action_by, action_by_role, action_to, action_to_role, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      invoiceId,
      trackingNo,
      actionType,
      message,
      actionBy,
      actionByRole,
      actionTo,
      actionToRole,
      remarks
    ]
  );
}

async function generateTrackingNo() {
  const year = new Date().getFullYear();

  const rows = await query(
    `
      SELECT COUNT(*) AS total
      FROM incoming_invoices
      WHERE YEAR(created_at) = ?
    `,
    [year]
  );

  const nextNumber = Number(rows[0]?.total || 0) + 1;
  return `INV-${year}-${String(nextNumber).padStart(5, "0")}`;
}

function mapInvoiceRow(row) {
  return {
    id: row.id,
    tracking_no: row.tracking_no,
    trackingNo: row.tracking_no,

    subject: row.subject,
    description: row.description,
    status: row.status,

    created_by: row.created_by,
    createdByName: row.created_by_name,
    createdByRole: row.created_by_role,

    assigned_clerk_id: row.assigned_clerk_id,
    assignedClerkName: row.assigned_clerk_name,

    supervisor_id: row.supervisor_id,
    supervisorName: row.supervisor_name,

    assigned_division_admin_id: row.assigned_division_admin_id,
    assignedDivisionAdminName: row.assigned_division_admin_name,

    confirmed_by: row.confirmed_by,
    confirmedByName: row.confirmed_by_name,

    validated_at: row.validated_at,
    completed_at: row.completed_at,
    completedAt: row.completed_at,

    created_at: row.created_at,
    createdAt: row.created_at,

    updated_at: row.updated_at,
    updatedAt: row.updated_at
  };
}

async function getInvoiceDetails(invoiceId) {
  const rows = await query(
    `
      SELECT
        inv.*,

        creator.full_name AS created_by_name,
        creator.role AS created_by_role,

        clerk.full_name AS assigned_clerk_name,
        supervisor.full_name AS supervisor_name,
        division.full_name AS assigned_division_admin_name,
        confirmer.full_name AS confirmed_by_name

      FROM incoming_invoices inv

      LEFT JOIN web_users creator
        ON creator.id = inv.created_by

      LEFT JOIN web_users clerk
        ON clerk.id = inv.assigned_clerk_id

      LEFT JOIN web_users supervisor
        ON supervisor.id = inv.supervisor_id

      LEFT JOIN web_users division
        ON division.id = inv.assigned_division_admin_id

      LEFT JOIN web_users confirmer
        ON confirmer.id = inv.confirmed_by

      WHERE inv.id = ?
      LIMIT 1
    `,
    [invoiceId]
  );

  if (!rows.length) return null;

  const invoice = mapInvoiceRow(rows[0]);

  const logs = await query(
    `
      SELECT
        log.*,
        actor.full_name AS action_by_name,
        receiver.full_name AS action_to_name
      FROM invoice_tracking_logs log
      LEFT JOIN web_users actor
        ON actor.id = log.action_by
      LEFT JOIN web_users receiver
        ON receiver.id = log.action_to
      WHERE log.invoice_id = ?
      ORDER BY log.created_at ASC, log.id ASC
    `,
    [invoiceId]
  );

  invoice.logs = logs.map((log) => ({
    id: log.id,
    invoice_id: log.invoice_id,
    tracking_no: log.tracking_no,
    action_type: log.action_type,
    message: log.message,
    action_by: log.action_by,
    actionByName: log.action_by_name,
    action_by_role: log.action_by_role,
    action_to: log.action_to,
    actionToName: log.action_to_name,
    action_to_role: log.action_to_role,
    remarks: log.remarks,
    created_at: log.created_at,
    createdAt: log.created_at
  }));

  return invoice;
}

/* =========================================================
   ACCOUNT OPTIONS
========================================================= */

router.get("/users/clerk-admins", async (req, res) => {
  try {
    const rows = await query(
      `
        SELECT id, full_name, username, role, division_name, status
        FROM web_users
        WHERE role = 'clerk_admin'
          AND status = 'active'
        ORDER BY full_name ASC
      `
    );

    return res.json({
      success: true,
      users: rows
    });
  } catch (err) {
    return sendError(res, 500, "Failed to load Clerk Admin accounts.", err);
  }
});

router.get("/users/division-admins", async (req, res) => {
  try {
    const rows = await query(
      `
        SELECT id, full_name, username, role, division_name, status
        FROM web_users
        WHERE role = 'division_admin'
          AND status = 'active'
        ORDER BY full_name ASC
      `
    );

    return res.json({
      success: true,
      users: rows
    });
  } catch (err) {
    return sendError(res, 500, "Failed to load Division Admin accounts.", err);
  }
});

/* =========================================================
   GET INVOICES
========================================================= */

router.get("/", async (req, res) => {
  try {
    const userId = req.query.user_id;
    const userRole = normalizeRole(req.query.role);

    if (!userId || !userRole) {
      return sendError(res, 400, "Missing user_id or role.");
    }

    let whereSql = "";
    const params = [];

    if (isHeadAdmin(userRole)) {
      whereSql = `
        WHERE inv.created_by = ?
           OR inv.status = 'completed'
      `;
      params.push(userId);
    } else if (userRole === "clerk_admin") {
      whereSql = `
        WHERE inv.assigned_clerk_id = ?
           OR inv.status = 'completed'
      `;
      params.push(userId);
    } else if (userRole === "supervisor") {
      whereSql = `
        WHERE inv.status = 'sent_to_supervisor'
           OR inv.supervisor_id = ?
           OR inv.status = 'completed'
      `;
      params.push(userId);
    } else if (userRole === "division_admin") {
      whereSql = `
        WHERE inv.assigned_division_admin_id = ?
           OR inv.status = 'completed'
      `;
      params.push(userId);
    } else {
      whereSql = `WHERE inv.status = 'completed'`;
    }

    const rows = await query(
      `
        SELECT
          inv.*,

          creator.full_name AS created_by_name,
          creator.role AS created_by_role,

          clerk.full_name AS assigned_clerk_name,
          supervisor.full_name AS supervisor_name,
          division.full_name AS assigned_division_admin_name,
          confirmer.full_name AS confirmed_by_name

        FROM incoming_invoices inv

        LEFT JOIN web_users creator
          ON creator.id = inv.created_by

        LEFT JOIN web_users clerk
          ON clerk.id = inv.assigned_clerk_id

        LEFT JOIN web_users supervisor
          ON supervisor.id = inv.supervisor_id

        LEFT JOIN web_users division
          ON division.id = inv.assigned_division_admin_id

        LEFT JOIN web_users confirmer
          ON confirmer.id = inv.confirmed_by

        ${whereSql}

        ORDER BY
          CASE
            WHEN inv.status = 'completed' THEN 2
            ELSE 1
          END ASC,
          inv.updated_at DESC,
          inv.id DESC
      `,
      params
    );

    return res.json({
      success: true,
      invoices: rows.map(mapInvoiceRow)
    });
  } catch (err) {
    return sendError(res, 500, "Failed to load invoices.", err);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const invoice = await getInvoiceDetails(req.params.id);

    if (!invoice) {
      return sendError(res, 404, "Invoice not found.");
    }

    return res.json({
      success: true,
      invoice
    });
  } catch (err) {
    return sendError(res, 500, "Failed to load invoice details.", err);
  }
});

/* =========================================================
   CREATE INVOICE
========================================================= */

router.post("/", async (req, res) => {
  try {
    const subject = cleanText(req.body.subject);
    const description = cleanText(req.body.description);
    const assignedClerkId = req.body.assigned_clerk_id;
    const createdBy = req.body.created_by;

    if (!subject || !description || !assignedClerkId || !createdBy) {
      return sendError(res, 400, "Missing required invoice fields.");
    }

    const creator = await requireWebUser(res, createdBy);
    if (!creator) return;

    if (!isHeadAdmin(creator.role)) {
      return sendError(res, 403, "Only Head Admin can create invoice subjects.");
    }

    const clerk = await requireWebUser(res, assignedClerkId);
    if (!clerk) return;

    if (normalizeRole(clerk.role) !== "clerk_admin") {
      return sendError(res, 400, "Assigned user must be a Clerk Admin.");
    }

    const trackingNo = await generateTrackingNo();

    const result = await query(
      `
        INSERT INTO incoming_invoices
        (tracking_no, subject, description, status, created_by, assigned_clerk_id)
        VALUES (?, ?, ?, 'sent_to_clerk', ?, ?)
      `,
      [trackingNo, subject, description, creator.id, clerk.id]
    );

    const invoiceId = result.insertId;

    await createTrackingLog({
      invoiceId,
      trackingNo,
      actionType: "create",
      message: `${creator.full_name} created invoice ${trackingNo}.`,
      actionBy: creator.id,
      actionByRole: creator.role
    });

    await createTrackingLog({
      invoiceId,
      trackingNo,
      actionType: "send_to_clerk",
      message: `${creator.full_name} assigned and sent the invoice to Clerk Admin ${clerk.full_name}.`,
      actionBy: creator.id,
      actionByRole: creator.role,
      actionTo: clerk.id,
      actionToRole: clerk.role
    });

    const invoice = await getInvoiceDetails(invoiceId);

    return res.status(201).json({
      success: true,
      message: "Invoice sent to Clerk Admin successfully.",
      invoice
    });
  } catch (err) {
    return sendError(res, 500, "Failed to create invoice.", err);
  }
});

/* =========================================================
   ACTIONS
========================================================= */

router.post("/:id/accept-clerk", async (req, res) => {
  try {
    const invoice = await getInvoiceDetails(req.params.id);
    if (!invoice) return sendError(res, 404, "Invoice not found.");

    const user = await requireWebUser(res, req.body.user_id);
    if (!user) return;

    if (normalizeRole(user.role) !== "clerk_admin") {
      return sendError(res, 403, "Only Clerk Admin can accept this invoice.");
    }

    if (Number(invoice.assigned_clerk_id) !== Number(user.id)) {
      return sendError(res, 403, "This invoice is assigned to another Clerk Admin.");
    }

    if (invoice.status !== "sent_to_clerk") {
      return sendError(res, 400, "Invoice is not waiting for Clerk Admin acceptance.");
    }

    await query(
      `UPDATE incoming_invoices SET status = 'accepted_by_clerk' WHERE id = ?`,
      [invoice.id]
    );

    await createTrackingLog({
      invoiceId: invoice.id,
      trackingNo: invoice.tracking_no,
      actionType: "accept_clerk",
      message: `${user.full_name} accepted the invoice as Clerk Admin.`,
      actionBy: user.id,
      actionByRole: user.role
    });

    return res.json({
      success: true,
      message: "Invoice accepted by Clerk Admin.",
      invoice: await getInvoiceDetails(invoice.id)
    });
  } catch (err) {
    return sendError(res, 500, "Failed to accept invoice.", err);
  }
});

router.post("/:id/send-supervisor", async (req, res) => {
  try {
    const invoice = await getInvoiceDetails(req.params.id);
    if (!invoice) return sendError(res, 404, "Invoice not found.");

    const user = await requireWebUser(res, req.body.user_id);
    if (!user) return;

    if (normalizeRole(user.role) !== "clerk_admin") {
      return sendError(res, 403, "Only Clerk Admin can send this invoice to Supervisor.");
    }

    if (Number(invoice.assigned_clerk_id) !== Number(user.id)) {
      return sendError(res, 403, "This invoice is assigned to another Clerk Admin.");
    }

    if (invoice.status !== "accepted_by_clerk") {
      return sendError(res, 400, "Clerk Admin must accept this invoice first.");
    }

    await query(
      `UPDATE incoming_invoices SET status = 'sent_to_supervisor' WHERE id = ?`,
      [invoice.id]
    );

    await createTrackingLog({
      invoiceId: invoice.id,
      trackingNo: invoice.tracking_no,
      actionType: "send_supervisor",
      message: `${user.full_name} sent the invoice to Supervisor.`,
      actionBy: user.id,
      actionByRole: user.role,
      actionToRole: "supervisor"
    });

    return res.json({
      success: true,
      message: "Invoice sent to Supervisor.",
      invoice: await getInvoiceDetails(invoice.id)
    });
  } catch (err) {
    return sendError(res, 500, "Failed to send invoice to Supervisor.", err);
  }
});

router.post("/:id/assign-division", async (req, res) => {
  try {
    const invoice = await getInvoiceDetails(req.params.id);
    if (!invoice) return sendError(res, 404, "Invoice not found.");

    const supervisor = await requireWebUser(res, req.body.user_id);
    if (!supervisor) return;

    if (normalizeRole(supervisor.role) !== "supervisor") {
      return sendError(res, 403, "Only Supervisor can assign a Division Admin.");
    }

    if (invoice.status !== "sent_to_supervisor") {
      return sendError(res, 400, "Invoice is not waiting for Supervisor assignment.");
    }

    const divisionAdmin = await requireWebUser(res, req.body.assigned_division_admin_id);
    if (!divisionAdmin) return;

    if (normalizeRole(divisionAdmin.role) !== "division_admin") {
      return sendError(res, 400, "Assigned user must be a Division Admin.");
    }

    await query(
      `
        UPDATE incoming_invoices
        SET status = 'assigned_to_division',
            supervisor_id = ?,
            assigned_division_admin_id = ?
        WHERE id = ?
      `,
      [supervisor.id, divisionAdmin.id, invoice.id]
    );

    await createTrackingLog({
      invoiceId: invoice.id,
      trackingNo: invoice.tracking_no,
      actionType: "assign_division",
      message: `${supervisor.full_name} assigned the invoice to Division Admin ${divisionAdmin.full_name}.`,
      actionBy: supervisor.id,
      actionByRole: supervisor.role,
      actionTo: divisionAdmin.id,
      actionToRole: divisionAdmin.role
    });

    return res.json({
      success: true,
      message: "Invoice assigned to Division Admin.",
      invoice: await getInvoiceDetails(invoice.id)
    });
  } catch (err) {
    return sendError(res, 500, "Failed to assign Division Admin.", err);
  }
});

router.post("/:id/accept-division", async (req, res) => {
  try {
    const invoice = await getInvoiceDetails(req.params.id);
    if (!invoice) return sendError(res, 404, "Invoice not found.");

    const divisionAdmin = await requireWebUser(res, req.body.user_id);
    if (!divisionAdmin) return;

    if (normalizeRole(divisionAdmin.role) !== "division_admin") {
      return sendError(res, 403, "Only Division Admin can accept this invoice.");
    }

    if (Number(invoice.assigned_division_admin_id) !== Number(divisionAdmin.id)) {
      return sendError(res, 403, "This invoice is assigned to another Division Admin.");
    }

    if (invoice.status !== "assigned_to_division") {
      return sendError(res, 400, "Invoice is not waiting for Division Admin acceptance.");
    }

    await query(
      `UPDATE incoming_invoices SET status = 'accepted_by_division' WHERE id = ?`,
      [invoice.id]
    );

    await createTrackingLog({
      invoiceId: invoice.id,
      trackingNo: invoice.tracking_no,
      actionType: "accept_division",
      message: `${divisionAdmin.full_name} accepted the invoice as Division Admin.`,
      actionBy: divisionAdmin.id,
      actionByRole: divisionAdmin.role
    });

    return res.json({
      success: true,
      message: "Invoice accepted by Division Admin.",
      invoice: await getInvoiceDetails(invoice.id)
    });
  } catch (err) {
    return sendError(res, 500, "Failed to accept invoice as Division Admin.", err);
  }
});

router.post("/:id/validate-return", async (req, res) => {
  try {
    const invoice = await getInvoiceDetails(req.params.id);
    if (!invoice) return sendError(res, 404, "Invoice not found.");

    const divisionAdmin = await requireWebUser(res, req.body.user_id);
    if (!divisionAdmin) return;

    if (normalizeRole(divisionAdmin.role) !== "division_admin") {
      return sendError(res, 403, "Only Division Admin can validate this invoice.");
    }

    if (Number(invoice.assigned_division_admin_id) !== Number(divisionAdmin.id)) {
      return sendError(res, 403, "This invoice is assigned to another Division Admin.");
    }

    if (invoice.status !== "accepted_by_division") {
      return sendError(res, 400, "Division Admin must accept this invoice first.");
    }

    await query(
      `
        UPDATE incoming_invoices
        SET status = 'returned_to_clerk',
            validated_at = NOW()
        WHERE id = ?
      `,
      [invoice.id]
    );

    await createTrackingLog({
      invoiceId: invoice.id,
      trackingNo: invoice.tracking_no,
      actionType: "validate_return",
      message: `${divisionAdmin.full_name} validated the invoice and returned it to Clerk Admin.`,
      actionBy: divisionAdmin.id,
      actionByRole: divisionAdmin.role,
      actionTo: invoice.assigned_clerk_id,
      actionToRole: "clerk_admin"
    });

    return res.json({
      success: true,
      message: "Invoice validated and returned to Clerk Admin.",
      invoice: await getInvoiceDetails(invoice.id)
    });
  } catch (err) {
    return sendError(res, 500, "Failed to validate and return invoice.", err);
  }
});

router.post("/:id/confirm", async (req, res) => {
  try {
    const invoice = await getInvoiceDetails(req.params.id);
    if (!invoice) return sendError(res, 404, "Invoice not found.");

    const clerk = await requireWebUser(res, req.body.user_id);
    if (!clerk) return;

    if (normalizeRole(clerk.role) !== "clerk_admin") {
      return sendError(res, 403, "Only Clerk Admin can confirm this invoice.");
    }

    if (Number(invoice.assigned_clerk_id) !== Number(clerk.id)) {
      return sendError(res, 403, "This invoice is assigned to another Clerk Admin.");
    }

    if (invoice.status !== "returned_to_clerk") {
      return sendError(res, 400, "Invoice must be returned to Clerk Admin before confirmation.");
    }

    await query(
      `
        UPDATE incoming_invoices
        SET status = 'completed',
            confirmed_by = ?,
            completed_at = NOW()
        WHERE id = ?
      `,
      [clerk.id, invoice.id]
    );

    await createTrackingLog({
      invoiceId: invoice.id,
      trackingNo: invoice.tracking_no,
      actionType: "confirm_report",
      message: `${clerk.full_name} confirmed the invoice. The record was moved to report/history.`,
      actionBy: clerk.id,
      actionByRole: clerk.role
    });

    return res.json({
      success: true,
      message: "Invoice confirmed and moved to report/history.",
      invoice: await getInvoiceDetails(invoice.id)
    });
  } catch (err) {
    return sendError(res, 500, "Failed to confirm invoice.", err);
  }
});

module.exports = router;
