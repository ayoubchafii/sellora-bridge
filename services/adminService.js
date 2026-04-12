// ══════════════════════════════════════════════════════════════
// ── ADMIN SERVICE — Pure database operations for clinic management
// ── No Express logic here — that lives in routes/admin.js
// ── Phase M: Added working_schedule, schedule_token
// ══════════════════════════════════════════════════════════════

const crypto = require("crypto");

// Gulf-market default schedule
const DEFAULT_WORKING_SCHEDULE = {
  sunday:    { open: "09:00", close: "18:00", breaks: [] },
  monday:    { open: "09:00", close: "18:00", breaks: [] },
  tuesday:   { open: "09:00", close: "18:00", breaks: [] },
  wednesday: { open: "09:00", close: "18:00", breaks: [] },
  thursday:  { open: "09:00", close: "18:00", breaks: [] },
  friday:    null,
  saturday:  { open: "09:00", close: "14:00", breaks: [] },
};

// Whitelist of fields that can be updated via the dashboard
const EDITABLE_FIELDS = [
  "clinic_name_ar", "clinic_name_en", "location", "doctors",
  "timezone", "notification_phone", "languages", "use_rag", "active",
  "knowledge_base", "priority_override", "clinic_summary",
  "appointments_cal_id", "working_hours_cal_id",
  "client_email",         // D-V2-4: client Gmail for calendar sharing
  "working_schedule",     // Phase M: JSONB working hours schedule
];

/**
 * Validate a working_schedule object.
 * Returns { valid: true } or { valid: false, reason: "..." }
 */
function validateWorkingSchedule(schedule) {
  if (typeof schedule !== "object" || schedule === null || Array.isArray(schedule)) {
    return { valid: false, reason: "Schedule must be a JSON object" };
  }

  const validDays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

  for (const day of validDays) {
    if (!(day in schedule)) {
      return { valid: false, reason: `Missing day: ${day}` };
    }

    const val = schedule[day];

    // null = closed — that's valid
    if (val === null) continue;

    if (typeof val !== "object" || Array.isArray(val)) {
      return { valid: false, reason: `${day} must be null (closed) or an object with open/close` };
    }

    if (!val.open || !val.close) {
      return { valid: false, reason: `${day} must have "open" and "close" fields` };
    }

    if (!timeRegex.test(val.open)) {
      return { valid: false, reason: `${day}.open must be HH:MM format (got "${val.open}")` };
    }

    if (!timeRegex.test(val.close)) {
      return { valid: false, reason: `${day}.close must be HH:MM format (got "${val.close}")` };
    }

    // Validate open < close
    if (val.open >= val.close) {
      return { valid: false, reason: `${day}: open time (${val.open}) must be before close time (${val.close})` };
    }

    // Validate breaks array
    if (!Array.isArray(val.breaks)) {
      return { valid: false, reason: `${day}.breaks must be an array` };
    }

    for (let i = 0; i < val.breaks.length; i++) {
      const brk = val.breaks[i];
      if (!brk.start || !brk.end) {
        return { valid: false, reason: `${day}.breaks[${i}] must have "start" and "end"` };
      }
      if (!timeRegex.test(brk.start)) {
        return { valid: false, reason: `${day}.breaks[${i}].start must be HH:MM format` };
      }
      if (!timeRegex.test(brk.end)) {
        return { valid: false, reason: `${day}.breaks[${i}].end must be HH:MM format` };
      }
      if (brk.start >= brk.end) {
        return { valid: false, reason: `${day}.breaks[${i}]: start must be before end` };
      }
      // Break must be within open/close
      if (brk.start < val.open || brk.end > val.close) {
        return { valid: false, reason: `${day}.breaks[${i}] must be within working hours (${val.open}-${val.close})` };
      }
    }
  }

  // Check at least one day is open
  const openDays = validDays.filter(d => schedule[d] !== null);
  if (openDays.length === 0) {
    return { valid: false, reason: "At least one day must be open" };
  }

  return { valid: true };
}

function createAdminService({ pool }) {

  // ── List all clinics (summary view)
  async function listClinics() {
    const result = await pool.query(
      `SELECT phone_number_id, clinic_name_ar, clinic_name_en, location, doctors,
              timezone, notification_phone, languages, use_rag, active, client_email,
              appointments_cal_id,
              LENGTH(knowledge_base) as kb_length,
              CASE WHEN priority_override IS NOT NULL AND priority_override != '' THEN true ELSE false END as has_override,
              LEFT(priority_override, 100) as override_preview
       FROM clinics
       ORDER BY clinic_name_en`
    );
    return result.rows;
  }

  // ── Get one clinic (full data + vector count)
  async function getClinic(phoneNumberId) {
    const result = await pool.query(
      "SELECT * FROM clinics WHERE phone_number_id = $1",
      [phoneNumberId]
    );
    if (result.rows.length === 0) return null;

    let vectorCount = 0;
    let chunks = [];
    if (result.rows[0].use_rag) {
      const vectors = await pool.query(
        "SELECT COUNT(*) as count FROM clinic_vectors WHERE clinic_id = $1",
        [phoneNumberId]
      );
      vectorCount = parseInt(vectors.rows[0].count);

      // D-V2-7: Return chunk content for chunk viewer
      const chunkResult = await pool.query(
        "SELECT id, content, LENGTH(content) as char_count FROM clinic_vectors WHERE clinic_id = $1 ORDER BY id",
        [phoneNumberId]
      );
      chunks = chunkResult.rows;
    }

    return { clinic: result.rows[0], vector_count: vectorCount, chunks };
  }

  // ── Update a clinic (partial update — only provided fields)
  async function updateClinic(phoneNumberId, fields) {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of EDITABLE_FIELDS) {
      if (fields[field] !== undefined) {
        // Validate working_schedule before saving
        if (field === "working_schedule") {
          let scheduleObj = fields[field];
          // Accept both string and object
          if (typeof scheduleObj === "string") {
            try { scheduleObj = JSON.parse(scheduleObj); }
            catch { return { error: "Invalid JSON in working_schedule" }; }
          }
          const validation = validateWorkingSchedule(scheduleObj);
          if (!validation.valid) {
            return { error: `Schedule validation failed: ${validation.reason}` };
          }
          updates.push(`${field} = $${paramIndex}::jsonb`);
          values.push(JSON.stringify(scheduleObj));
        } else {
          updates.push(`${field} = $${paramIndex}`);
          values.push(fields[field]);
        }
        paramIndex++;
      }
    }

    if (updates.length === 0) return null;

    values.push(phoneNumberId);

    const result = await pool.query(
      `UPDATE clinics SET ${updates.join(", ")} WHERE phone_number_id = $${paramIndex} RETURNING phone_number_id, clinic_name_ar, active`,
      values
    );

    if (result.rows.length === 0) return null;

    return {
      clinic: result.rows[0],
      fields_changed: updates.map(u => u.split(" =")[0]),
    };
  }

  // ── Create a new clinic
  async function createClinic(data) {
    // Check if already exists
    const existing = await pool.query(
      "SELECT phone_number_id FROM clinics WHERE phone_number_id = $1",
      [data.phone_number_id]
    );
    if (existing.rows.length > 0) return { error: "exists" };

    // Use provided schedule or default
    let schedule = DEFAULT_WORKING_SCHEDULE;
    if (data.working_schedule) {
      let scheduleObj = data.working_schedule;
      if (typeof scheduleObj === "string") {
        try { scheduleObj = JSON.parse(scheduleObj); } catch { /* use default */ }
      }
      const validation = validateWorkingSchedule(scheduleObj);
      if (validation.valid) schedule = scheduleObj;
    }

    // Generate schedule token for future Magic Link
    const scheduleToken = crypto.randomUUID();

    const result = await pool.query(
      `INSERT INTO clinics (
        phone_number_id, clinic_name_ar, clinic_name_en, location, doctors,
        timezone, notification_phone, languages, use_rag, active, knowledge_base,
        appointments_cal_id, working_hours_cal_id, client_email,
        working_schedule, schedule_token
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, FALSE, $9, $10, $11, $12, $13::jsonb, $14)
      RETURNING phone_number_id, clinic_name_ar, schedule_token`,
      [
        data.phone_number_id,
        data.clinic_name_ar,
        data.clinic_name_en || "",
        data.location || "",
        data.doctors || "",
        data.timezone || "Asia/Riyadh",
        data.notification_phone || "",
        data.languages || "ar",
        data.knowledge_base || "",
        data.appointments_cal_id || null,
        data.working_hours_cal_id || null,
        data.client_email || null,
        JSON.stringify(schedule),
        scheduleToken,
      ]
    );

    return { clinic: result.rows[0] };
  }

  // ── Delete a clinic and its vectors
  async function deleteClinic(phoneNumberId) {
    await pool.query("DELETE FROM clinic_vectors WHERE clinic_id = $1", [phoneNumberId]);

    const result = await pool.query(
      "DELETE FROM clinics WHERE phone_number_id = $1 RETURNING clinic_name_ar",
      [phoneNumberId]
    );

    if (result.rows.length === 0) return null;
    return { clinic_name: result.rows[0].clinic_name_ar };
  }

  return { listClinics, getClinic, updateClinic, createClinic, deleteClinic, validateWorkingSchedule };
}

module.exports = { createAdminService };
