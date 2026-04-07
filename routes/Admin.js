// ══════════════════════════════════════════════════════════════
// ── ADMIN ROUTES — Express Router for /api/clinics
// ── Handles HTTP layer, delegates DB work to adminService
// ── Phase D-V2: Added PDF upload + Sara sandbox endpoints
// ══════════════════════════════════════════════════════════════

const express = require("express");

function createAdminRouter({ pool, loadClientsFromDB, ADMIN_SECRET, bedrockClient, ragService }) {
  const router = express.Router();
  const { createAdminService } = require("../services/adminService");
  const { createPdfService } = require("../services/pdfService");
  const { createSandboxService } = require("../services/sandboxService");

  const adminService = createAdminService({ pool });
  const pdfService = bedrockClient ? createPdfService({ bedrockClient }) : null;
  const sandboxService = (bedrockClient && pool) ? createSandboxService({ bedrockClient, pool, ragService }) : null;

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

  // ── GET /:id — Get one clinic (full data + chunks)
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

  // ══════════════════════════════════════════════════════════════
  // ── PHASE D-V2 ENDPOINTS
  // ══════════════════════════════════════════════════════════════

  // ── POST /:id/upload-pdf — Extract text from PDF + auto-detect tier
  router.post("/:id/upload-pdf", async (req, res) => {
    if (!pdfService) {
      return res.status(503).json({ error: "PDF service not available (Bedrock client not initialized)" });
    }

    const { pdf_base64 } = req.body;
    if (!pdf_base64) {
      return res.status(400).json({ error: "Missing pdf_base64 in request body" });
    }

    try {
      // Step 1: Verify clinic exists
      const clinicData = await adminService.getClinic(req.params.id);
      if (!clinicData) {
        return res.status(404).json({ error: "Clinic not found" });
      }

      console.log(`PDF upload started for clinic ${req.params.id}`);

      // Step 2: Extract text from PDF via Bedrock Claude
      const extraction = await pdfService.extractTextFromPdf(pdf_base64);
      console.log(`PDF extracted: ${extraction.char_count} characters`);

      // Step 3: Validate extraction (scanned image trap)
      const validation = pdfService.validateExtraction(extraction.text);
      if (!validation.valid) {
        console.log(`PDF rejected: ${validation.reason}`);
        return res.status(422).json({
          error: validation.reason,
          message: validation.message,
          char_count: extraction.char_count,
        });
      }

      // Step 4: Auto-detect tier based on text length
      const tier = pdfService.detectTier(extraction.char_count);
      console.log(`PDF tier detected: ${tier} (${extraction.char_count} chars)`);

      let result;

      if (tier === "basic") {
        // Basic: Store extracted text directly in knowledge_base column
        await adminService.updateClinic(req.params.id, {
          knowledge_base: extraction.text,
          use_rag: false,
        });
        result = {
          status: "processed",
          tier: "basic",
          char_count: extraction.char_count,
          extracted_text: extraction.text,
        };
      } else {
        // Enterprise: Chunk + embed via ragService
        if (!ragService) {
          return res.status(503).json({ error: "RAG service not available for enterprise processing" });
        }

        // Generate a summary for the clinic (first 2000 chars as summary)
        const summaryText = extraction.text.substring(0, 2000);

        const embedResult = await ragService.chunkAndEmbed(
          req.params.id,
          extraction.text,
          summaryText
        );

        result = {
          status: "processed",
          tier: "enterprise",
          char_count: extraction.char_count,
          chunks_total: embedResult.chunks_total,
          chunks_embedded: embedResult.chunks_embedded,
          extracted_text: extraction.text,
        };
      }

      // Refresh client cache so Sara picks up new data immediately
      await loadClientsFromDB();

      console.log(`PDF processing complete for clinic ${req.params.id}: ${tier}`);
      return res.status(200).json(result);

    } catch (err) {
      console.error("PDF upload error:", err.message);
      return res.status(500).json({ error: "PDF processing failed", details: err.message });
    }
  });

  // ── POST /:id/sandbox — Sara QA sandbox chat
  router.post("/:id/sandbox", async (req, res) => {
    if (!sandboxService) {
      return res.status(503).json({ error: "Sandbox service not available" });
    }

    const { message, clear } = req.body;

    // Clear session if requested
    if (clear) {
      sandboxService.clearSession(req.params.id);
      return res.status(200).json({ status: "session_cleared" });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Missing message in request body" });
    }

    try {
      console.log(`Sandbox chat for ${req.params.id}: "${message.substring(0, 50)}..."`);

      const result = await sandboxService.chat(req.params.id, message);

      return res.status(200).json({
        response: result.response,
        raw_response: result.raw_response,
        tags_detected: result.tags_detected,
      });

    } catch (err) {
      console.error("Sandbox error:", err.message);
      return res.status(500).json({ error: "Sandbox failed", details: err.message });
    }
  });

  // ── DELETE /:id/sandbox — Clear sandbox session
  router.delete("/:id/sandbox", async (req, res) => {
    if (!sandboxService) {
      return res.status(503).json({ error: "Sandbox service not available" });
    }
    sandboxService.clearSession(req.params.id);
    return res.status(200).json({ status: "session_cleared" });
  });

  return router;
}

module.exports = { createAdminRouter };
