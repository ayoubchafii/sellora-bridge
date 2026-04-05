// ══════════════════════════════════════════════════════════════
// ── ADMIN ROUTES — Express Router for /api/clinics
// ── Handles HTTP layer, delegates DB work to adminService
// ══════════════════════════════════════════════════════════════

const express = require("express");

function createAdminRouter({ pool, loadClientsFromDB, ADMIN_SECRET }) {
  const router = express.Router();
  const { createAdminService } = require("../services/adminService");
  const adminService = createAdminService({ pool });

  // ── CORS for dashboard (Netlify → Railway)
  router.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // ── Auth middleware — every route below requires ADMIN_SECRET
  router.use((req, res, next) => {
    const authHeader = req.headers.authorization || "";
    if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  // ── GET / — List all clinics
  router.get("/", async (req, res) => {
    try {
      const clinics = await adminService.listClinics();
      return res.status(200).json({ clinics });
    } catch (err) {
      console.error("Admin listClinics error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /:id — Get one clinic (full data)
  router.get("/:id", async (req, res) => {
    try {
      const data = await adminService.getClinic(req.params.id);
      if (!data) return res.status(404).json({ error: "Clinic not found" });
      return res.status(200).json(data);
    } catch (err) {
      console.error("Admin getClinic error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ── PUT /:id — Update a clinic
  router.put("/:id", async (req, res) => {
    try {
      const result = await adminService.updateClinic(req.params.id, req.body);
      if (!result) return res.status(400).json({ error: "No valid fields to update or clinic not found" });

      await loadClientsFromDB();
      console.log(`Admin updated clinic ${req.params.id}: ${result.fields_changed.join(", ")}`);
      return res.status(200).json({ status: "updated", ...result });
    } catch (err) {
      console.error("Admin updateClinic error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ── POST / — Create a new clinic
  router.post("/", async (req, res) => {
    const { phone_number_id, clinic_name_ar } = req.body;
    if (!phone_number_id || !clinic_name_ar) {
      return res.status(400).json({ error: "phone_number_id and clinic_name_ar are required" });
    }

    try {
      const result = await adminService.createClinic(req.body);
      if (result.error === "exists") {
        return res.status(409).json({ error: "Clinic with this phone_number_id already exists" });
      }

      console.log(`Admin created clinic: ${clinic_name_ar} (${phone_number_id})`);
      return res.status(201).json({ status: "created", ...result });
    } catch (err) {
      console.error("Admin createClinic error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ── DELETE /:id — Delete a clinic and its vectors
  router.delete("/:id", async (req, res) => {
    try {
      const result = await adminService.deleteClinic(req.params.id);
      if (!result) return res.status(404).json({ error: "Clinic not found" });

      await loadClientsFromDB();
      console.log(`Admin deleted clinic: ${result.clinic_name} (${req.params.id})`);
      return res.status(200).json({ status: "deleted", ...result });
    } catch (err) {
      console.error("Admin deleteClinic error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
