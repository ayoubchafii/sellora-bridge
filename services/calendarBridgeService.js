// ══════════════════════════════════════════════════════════════
// ── CALENDAR BRIDGE SERVICE
// ── Triggers Make.com to create Google Calendars for a clinic
// ── Handles callback from Make.com after calendars are created
// ── Phase M — Only creates Appointments calendar (no Working Hours)
// ── Timezone fix: sends clinic timezone to Make.com for proper calendar metadata
// ══════════════════════════════════════════════════════════════

const axios = require("axios");

function createCalendarBridgeService({ pool }) {

  /**
   * Trigger Make.com to create calendars for a clinic.
   * Validates clinic exists and has client_email before firing.
   * Returns { status: "pending" } immediately — callback handles the rest.
   */
  async function triggerCalendarCreation(clinicId) {
    const MAKE_BRIDGE_WEBHOOK_URL = process.env.MAKE_BRIDGE_WEBHOOK_URL;
    if (!MAKE_BRIDGE_WEBHOOK_URL) {
      throw new Error("MAKE_BRIDGE_WEBHOOK_URL not set");
    }

    // Read clinic from DB (not cache — inactive clinics aren't cached)
    const result = await pool.query(
      "SELECT phone_number_id, clinic_name_en, clinic_name_ar, client_email, appointments_cal_id, timezone FROM clinics WHERE phone_number_id = $1",
      [clinicId]
    );

    if (result.rows.length === 0) {
      throw new Error("Clinic not found");
    }

    const clinic = result.rows[0];

    // Validate: client_email required for sharing
    if (!clinic.client_email || !clinic.client_email.trim()) {
      throw new Error("Client email is required before creating calendars. Fill it in the dashboard first.");
    }

    // Warn if calendars already exist
    if (clinic.appointments_cal_id) {
      throw new Error("Calendars already exist for this clinic. Delete them manually in Google Calendar before re-creating.");
    }

    // Build the clinic display name (prefer English, fallback to Arabic)
    const clinicName = clinic.clinic_name_en || clinic.clinic_name_ar;

    // Fire webhook to Make.com
    const payload = {
      clinic_id: clinicId,
      clinic_name: clinicName,
      client_email: clinic.client_email.trim(),
      timezone: clinic.timezone || "Asia/Riyadh",
      action: "create_calendars",
    };

    console.log("BRIDGE: Triggering Make.com calendar creation:", JSON.stringify(payload));

    try {
      await axios.post(MAKE_BRIDGE_WEBHOOK_URL, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      });
      console.log("BRIDGE: Make.com webhook fired successfully");
    } catch (err) {
      console.error("BRIDGE: Make.com webhook failed:", err.message);
      throw new Error("Failed to reach Make.com. Is the scenario active?");
    }

    return { status: "pending", clinic_name: clinicName };
  }

  /**
   * Handle callback from Make.com after calendars are created.
   * Updates the clinic's appointments_cal_id in the database.
   * Validates the callback secret to prevent unauthorized access.
   */
  async function handleCalendarCallback(clinicId, appointmentsCalId, callbackSecret) {
    const BRIDGE_CALLBACK_SECRET = process.env.BRIDGE_CALLBACK_SECRET;

    // Validate secret
    if (!BRIDGE_CALLBACK_SECRET || callbackSecret !== BRIDGE_CALLBACK_SECRET) {
      throw new Error("Invalid callback secret");
    }

    // Validate required fields
    if (!clinicId || !appointmentsCalId) {
      throw new Error("Missing clinic_id or appointments_cal_id in callback");
    }

    // Update database with the new calendar ID
    const result = await pool.query(
      "UPDATE clinics SET appointments_cal_id = $1 WHERE phone_number_id = $2 RETURNING clinic_name_ar",
      [appointmentsCalId, clinicId]
    );

    if (result.rows.length === 0) {
      throw new Error("Clinic not found for callback");
    }

    console.log(`BRIDGE: Calendars ready for ${result.rows[0].clinic_name_ar} (${clinicId}). Calendar ID: ${appointmentsCalId}`);

    return {
      status: "calendars_ready",
      clinic_name: result.rows[0].clinic_name_ar,
      appointments_cal_id: appointmentsCalId,
    };
  }

  /**
   * Check if a clinic's calendars are ready (for dashboard polling).
   */
  async function getCalendarStatus(clinicId) {
    const result = await pool.query(
      "SELECT appointments_cal_id, client_email FROM clinics WHERE phone_number_id = $1",
      [clinicId]
    );

    if (result.rows.length === 0) return null;

    return {
      has_calendars: !!result.rows[0].appointments_cal_id,
      has_email: !!result.rows[0].client_email,
      appointments_cal_id: result.rows[0].appointments_cal_id || null,
    };
  }

  return { triggerCalendarCreation, handleCalendarCallback, getCalendarStatus };
}

module.exports = { createCalendarBridgeService };
