// ══════════════════════════════════════════════════════════════
// ── BRIDGE ROUTES — Express Router for /api/bridge
// ── Handles calendar creation trigger and Make.com callback
// ── Phase M
// ══════════════════════════════════════════════════════════════

const express = require("express");

function createBridgeRouter({ pool, loadClientsFromDB, ADMIN_SECRET }) {
  const router = express.Router();
  const { createCalendarBridgeService } = require("../services/calendarBridgeService");

  const bridgeService = createCalendarBridgeService({ pool });

  // ── CORS for dashboard (Netlify → Railway)
  router.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // ── POST /api/bridge/create-calendars — Admin triggers calendar creation
  router.post("/create-calendars", async (req, res) => {
    const authHeader = req.headers.authorization || "";
    if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { clinic_id } = req.body;
    if (!clinic_id) {
      return res.status(400).json({ error: "Missing clinic_id" });
    }

    try {
      const result = await bridgeService.triggerCalendarCreation(clinic_id);
      console.log(`BRIDGE: Calendar creation triggered for ${clinic_id}`);
      return res.status(200).json(result);
    } catch (err) {
      console.error("BRIDGE trigger error:", err.message);
      return res.status(400).json({ error: err.message });
    }
  });

  // ── POST /api/bridge/calendars-ready — Make.com callback (secret in body, not header)
  router.post("/calendars-ready", async (req, res) => {
    const { clinic_id, appointments_cal_id, secret } = req.body;

    if (!clinic_id || !appointments_cal_id || !secret) {
      return res.status(400).json({ error: "Missing required fields: clinic_id, appointments_cal_id, secret" });
    }

    try {
      const result = await bridgeService.handleCalendarCallback(clinic_id, appointments_cal_id, secret);
      await loadClientsFromDB();
      console.log(`BRIDGE: Callback processed — ${result.clinic_name} is ready`);
      return res.status(200).json(result);
    } catch (err) {
      console.error("BRIDGE callback error:", err.message);
      return res.status(400).json({ error: err.message });
    }
  });

  // ── GET /api/bridge/status/:id — Dashboard polls this
  router.get("/status/:id", async (req, res) => {
    const authHeader = req.headers.authorization || "";
    if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const status = await bridgeService.getCalendarStatus(req.params.id);
      if (!status) return res.status(404).json({ error: "Clinic not found" });
      return res.status(200).json(status);
    } catch (err) {
      console.error("BRIDGE status error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  });

  return router;
}

module.exports = { createBridgeRouter };
