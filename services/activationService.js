// ══════════════════════════════════════════════════════════════
// ── ACTIVATION SERVICE
// ── Handles clinic activation + WhatsApp confirmation (B8)
// ══════════════════════════════════════════════════════════════

/**
 * Creates an Express route handler for POST /api/activate
 * Verifies clinic setup is complete, activates it, and notifies the owner.
 */
function createActivationHandler({ pool, loadClientsFromDB, sendWhatsApp, ADMIN_SECRET }) {
  return async (req, res) => {
    // ── Auth check
    const authHeader = req.headers.authorization || "";
    if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { phone_number_id } = req.body;
    if (!phone_number_id) {
      return res.status(400).json({ error: "Missing phone_number_id" });
    }

    try {
      // ── Query DB directly (not cache — inactive clinics aren't cached)
      const result = await pool.query(
        "SELECT * FROM clinics WHERE phone_number_id = $1",
        [phone_number_id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Clinic not found" });
      }

      const clinic = result.rows[0];

      // ── Check required fields
      const missing = [];
      if (!clinic.appointments_cal_id) missing.push("appointments_cal_id");
      if (!clinic.working_hours_cal_id) missing.push("working_hours_cal_id");
      if (!clinic.knowledge_base) missing.push("knowledge_base");

      if (missing.length > 0) {
        return res.status(400).json({
          error: "Clinic not ready — missing fields",
          missing: missing,
        });
      }

      // ── Already active?
      if (clinic.active) {
        return res.status(200).json({ status: "already_active", clinic_name: clinic.clinic_name_ar });
      }

      // ── Activate
      await pool.query(
        "UPDATE clinics SET active = TRUE WHERE phone_number_id = $1",
        [phone_number_id]
      );

      // ── Refresh client cache so Sara starts responding immediately
      await loadClientsFromDB();

      // ── Send WhatsApp confirmation to clinic owner (B8)
      if (clinic.notification_phone) {
        const confirmationMessage =
          `مرحباً! تم تفعيل مساعدة الحجز الذكية "سارة" لعيادتكم ${clinic.clinic_name_ar} بنجاح.\n\n` +
          `يمكن لمرضاكم الآن حجز المواعيد عبر الواتساب.\n\n` +
          `للتجربة، أرسلوا "سلام" على نفس هذا الرقم.`;

        try {
          await sendWhatsApp(clinic.notification_phone, confirmationMessage, phone_number_id);
          console.log(`Activation confirmation sent to ${clinic.notification_phone}`);
        } catch (waErr) {
          console.error("Failed to send activation WhatsApp:", waErr.message);
        }
      }

      console.log(`Clinic activated: ${clinic.clinic_name_ar} (${phone_number_id})`);
      return res.status(200).json({
        status: "activated",
        clinic_name: clinic.clinic_name_ar,
        notification_sent: !!clinic.notification_phone,
      });

    } catch (err) {
      console.error("Activation error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  };
}

module.exports = { createActivationHandler };
