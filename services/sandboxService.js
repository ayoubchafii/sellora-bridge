// ══════════════════════════════════════════════════════════════
// ── SANDBOX SERVICE — Sara QA Testing for Admin Dashboard
// ── Replicates prompt assembly from callClaude() without
// ── Redis, WhatsApp, or tag processing. Ephemeral sessions.
// ── Part of Phase D-V2 (Command Center)
// ══════════════════════════════════════════════════════════════

const fs = require("fs");
const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

const MODEL_ID = "global.anthropic.claude-sonnet-4-6";

// Load Sara's base prompt (same file as production)
let SARA_BASE_PROMPT = "";
try {
  SARA_BASE_PROMPT = fs.readFileSync("sara_prompt_base.txt", "utf8");
} catch (err) {
  console.error("Sandbox: Could not load sara_prompt_base.txt:", err.message);
}

/**
 * Initialize Sandbox service
 * @param {object} deps - { bedrockClient, pool, ragService }
 */
function createSandboxService({ bedrockClient, pool, ragService }) {

  // In-memory session store: clinicId → message history array
  // Ephemeral — cleared on server restart, no Redis needed
  const sessions = new Map();
  const MAX_HISTORY = 10;

  /**
   * Get or create a sandbox session for a clinic
   */
  function getSession(clinicId) {
    if (!sessions.has(clinicId)) {
      sessions.set(clinicId, []);
    }
    return sessions.get(clinicId);
  }

  /**
   * Clear sandbox session for a clinic
   */
  function clearSession(clinicId) {
    sessions.delete(clinicId);
  }

  /**
   * Build the dynamic prompt — mirrors callClaude() logic exactly
   * but reads directly from DB instead of client cache
   */
  async function buildPrompt(clinicId, userMessage) {
    let dynamicPrompt = SARA_BASE_PROMPT;

    // Load clinic data directly from DB (not cache — sandbox may test inactive clinics)
    const result = await pool.query(
      "SELECT * FROM clinics WHERE phone_number_id = $1",
      [clinicId]
    );

    if (result.rows.length === 0) {
      throw new Error("Clinic not found");
    }

    const clinic = result.rows[0];

    // ── Inject clinic info (mirrors callClaude lines 1028-1068)
    dynamicPrompt += `\n\nمعلومات العيادة:`;
    dynamicPrompt += `\n- الاسم: ${clinic.clinic_name_ar}`;
    if (clinic.location) dynamicPrompt += `\n- الموقع: ${clinic.location}`;
    if (clinic.doctors) dynamicPrompt += `\n- الأطباء: ${clinic.doctors}`;

    // ── Dual-tier knowledge system (mirrors callClaude lines 1033-1057)
    if (clinic.use_rag && ragService) {
      try {
        const chunks = await ragService.searchClinicVectors(clinicId, userMessage, 3);
        if (clinic.clinic_summary) dynamicPrompt += `\n${clinic.clinic_summary}`;
        if (chunks.length > 0) {
          dynamicPrompt += `\n\nمعلومات ذات صلة من قاعدة بيانات العيادة:`;
          for (const chunk of chunks) {
            dynamicPrompt += `\n${chunk.content}`;
          }
        } else if (clinic.knowledge_base) {
          dynamicPrompt += `\n${clinic.knowledge_base}`;
        }
      } catch (ragErr) {
        console.error("Sandbox RAG error, falling back to text:", ragErr.message);
        if (clinic.knowledge_base) dynamicPrompt += `\n${clinic.knowledge_base}`;
        else if (clinic.clinic_summary) dynamicPrompt += `\n${clinic.clinic_summary}`;
      }
    } else {
      if (clinic.knowledge_base) dynamicPrompt += `\n${clinic.knowledge_base}`;
    }

    // Languages
    if (clinic.languages) {
      const langMap = { ar: "العربية", en: "الإنجليزية", fr: "الفرنسية" };
      const langNames = clinic.languages.split(",").map(l => langMap[l.trim()] || l.trim()).join(" و");
      dynamicPrompt += `\n- اللغات: ${langNames} فقط. أي لغة أخرى → رد بالعربية.`;
    }

    // Priority override — injected LAST
    if (clinic.priority_override) {
      dynamicPrompt += `\n\nتحديثات مهمة (لها الأولوية المطلقة على أي معلومات أخرى):\n${clinic.priority_override}`;
    }

    // Sandbox test user — no real phone, no patient profile
    dynamicPrompt += `\n\nرقم واتساب المريض الحالي: +000000000000`;
    dynamicPrompt += `\n\n[ملاحظة للنظام: هذه جلسة اختبار من لوحة التحكم. أجب بشكل طبيعي كأنك تتحدث مع مريض حقيقي.]`;

    return dynamicPrompt;
  }

  /**
   * Strip all hidden tags from Sara's response
   * In sandbox mode, tags are informational only — no actions are triggered
   */
  function stripTags(text) {
    return text
      .replace(/\[BOOKING:[^\]]+\]/g, "")
      .replace(/\[CANCEL:[^\]]+\]/g, "")
      .replace(/\[RESCHEDULE:[^\]]+\]/g, "")
      .replace(/\[CHECK_AVAILABILITY:[^\]]+\]/g, "")
      .trim();
  }

  /**
   * Send a message to Sara in sandbox mode
   * @param {string} clinicId - phone_number_id of the clinic
   * @param {string} userMessage - admin's test question
   * @returns {object} { response, raw_response, tags_detected }
   */
  async function chat(clinicId, userMessage) {
    if (!userMessage || !userMessage.trim()) {
      throw new Error("Empty message");
    }

    // Get/create session history
    const history = getSession(clinicId);

    // Add user message to session
    history.push({ role: "user", content: userMessage });

    // Trim history if too long
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    // Build prompt (reads from DB + RAG if applicable)
    const dynamicPrompt = await buildPrompt(clinicId, userMessage);

    // Call Bedrock
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: dynamicPrompt }],
      messages: history.map(msg => ({
        role: msg.role,
        content: [{ text: msg.content }],
      })),
      inferenceConfig: {
        maxTokens: 500,
        temperature: 0.7,
      },
    });

    const response = await bedrockClient.send(command);
    const rawResponse = response.output.message.content[0].text;

    // Detect tags before stripping (useful for admin QA visibility)
    const tagsDetected = [];
    if (rawResponse.match(/\[BOOKING:[^\]]+\]/)) tagsDetected.push("BOOKING");
    if (rawResponse.match(/\[CANCEL:[^\]]+\]/)) tagsDetected.push("CANCEL");
    if (rawResponse.match(/\[RESCHEDULE:[^\]]+\]/)) tagsDetected.push("RESCHEDULE");
    if (rawResponse.match(/\[CHECK_AVAILABILITY:[^\]]+\]/)) tagsDetected.push("CHECK_AVAILABILITY");

    // Strip tags for clean display
    const cleanResponse = stripTags(rawResponse);

    // Add assistant response to session history
    history.push({ role: "assistant", content: rawResponse });

    return {
      response: cleanResponse,
      raw_response: rawResponse,
      tags_detected: tagsDetected,
    };
  }

  return {
    chat,
    clearSession,
  };
}

module.exports = { createSandboxService };
