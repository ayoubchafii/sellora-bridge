// ══════════════════════════════════════════════════════════════
// ── ADMIN SERVICE — Pure database operations for clinic management
// ── No Express logic here — that lives in routes/admin.js
// ══════════════════════════════════════════════════════════════

// Whitelist of fields that can be updated via the dashboard
const EDITABLE_FIELDS = [
  "clinic_name_ar", "clinic_name_en", "location", "doctors",
  "timezone", "notification_phone", "languages", "use_rag", "active",
  "knowledge_base", "priority_override", "clinic_summary",
  "appointments_cal_id", "working_hours_cal_id"
];

function createAdminService({ pool }) {

  // ── List all clinics (summary view)
  async function listClinics() {
    const result = await pool.query(
      `SELECT phone_number_id, clinic_name_ar, clinic_name_en, location, doctors,
              timezone, notification_phone, languages, use_rag, active,
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
    if (result.rows[0].use_rag) {
      const vectors = await pool.query(
        "SELECT COUNT(*) as count FROM clinic_vectors WHERE clinic_id = $1",
        [phoneNumberId]
      );
      vectorCount = parseInt(vectors.rows[0].count);
    }

    return { clinic: result.rows[0], vector_count: vectorCount };
  }

  // ── Update a clinic (partial update — only provided fields)
  async function updateClinic(phoneNumberId, fields) {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of EDITABLE_FIELDS) {
      if (fields[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(fields[field]);
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

    const result = await pool.query(
      `INSERT INTO clinics (
        phone_number_id, clinic_name_ar, clinic_name_en, location, doctors,
        timezone, notification_phone, languages, use_rag, active, knowledge_base,
        appointments_cal_id, working_hours_cal_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, FALSE, $9, $10, $11)
      RETURNING phone_number_id, clinic_name_ar`,
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

  return { listClinics, getClinic, updateClinic, createClinic, deleteClinic };
}

module.exports = { createAdminService };
