// ══════════════════════════════════════════════════════════════
// ── PDF EXTRACTION API — Called by Make.com onboarding pipeline
// ── Uses Google Gemini for OCR with automatic retry on rate limits
// ══════════════════════════════════════════════════════════════

const axios = require("axios");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const EXTRACTION_PROMPT = `You are a dental clinic document extraction AI. You must extract ALL information from this PDF document and return ONLY a valid JSON object. No explanation, no markdown, no backticks — just raw JSON.

The document is a dental clinic's services menu, price list, or brochure. It may be in Arabic, English, or both. It may be a clean PDF or a scanned image.

Extract and return this EXACT JSON structure:

{"services_and_prices": "The COMPLETE list of every service and its price, written in Arabic. Format each as: service name: price. One per line. If the original is in English, translate service names to Arabic. Keep prices in the original currency. Include ALL services — miss nothing.", "doctors": "Every doctor name and their specialty mentioned in the document. Format each doctor as a separate line. In Arabic. If no doctors are mentioned, return empty string.", "additional_info": "Any other useful information found in the document — insurance accepted, special offers, branch locations, parking info, payment methods. In Arabic. If nothing extra, return empty string.", "original_language": "ar or en — the primary language of the document", "char_count": 0}

CRITICAL RULES:
- services_and_prices MUST be in Arabic regardless of the document language
- Include EVERY service and EVERY price you find — completeness is more important than formatting
- If a price range exists (e.g., 500-800), include the full range
- If a service has no price listed, write السعر غير محدد next to it
- char_count must be the total character count of the services_and_prices field
- Return ONLY the JSON object — no other text before or after it
- If the document is unreadable or not a clinic document, return: {"error": "unable_to_read", "reason": "description of the problem"}`;

module.exports = function (app) {

  app.post("/api/extract-pdf", async (req, res) => {
    try {
      const { pdf_url } = req.body;

      if (!pdf_url) {
        return res.status(400).json({ status: "error", message: "Missing pdf_url" });
      }

      if (!GEMINI_API_KEY) {
        return res.status(500).json({ status: "error", message: "GEMINI_API_KEY not configured on Railway" });
      }

      console.log(`EXTRACT-PDF: Processing ${pdf_url.substring(0, 80)}...`);

      // ── Call Gemini with retry logic (up to 3 attempts)
      const maxRetries = 3;
      let lastError = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const geminiResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
              contents: [{
                role: "user",
                parts: [
                  { text: EXTRACTION_PROMPT },
                  { fileData: { mimeType: "application/pdf", fileUri: pdf_url } }
                ]
              }],
              generationConfig: {
                responseMimeType: "application/json"
              }
            },
            {
              headers: { "Content-Type": "application/json" },
              timeout: 120000 // 2 minutes — large PDFs take time
            }
          );

          // Extract text from response
          const responseText = geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

          // Clean any accidental markdown backticks (Flaw 2 safety net)
          const cleanedText = responseText
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();

          // Parse JSON
          let extracted;
          try {
            extracted = JSON.parse(cleanedText);
          } catch (parseErr) {
            console.error(`EXTRACT-PDF: JSON parse failed on attempt ${attempt}:`, cleanedText.substring(0, 200));
            lastError = new Error("Invalid JSON from Gemini: " + parseErr.message);
            continue; // Retry — sometimes Gemini returns bad JSON on first try
          }

          // Recalculate char_count ourselves (don't trust LLM math)
          extracted.char_count = (extracted.services_and_prices || "").length;

          console.log(`EXTRACT-PDF: Success on attempt ${attempt}. char_count: ${extracted.char_count}`);

          return res.json({
            status: "success",
            result: extracted
          });

        } catch (err) {
          lastError = err;
          const statusCode = err.response?.status;

          if (statusCode === 429) {
            // Rate limited — exponential backoff: 30s, 60s, 90s
            const waitTime = attempt * 30;
            console.log(`EXTRACT-PDF: Rate limited (attempt ${attempt}/${maxRetries}). Waiting ${waitTime}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            continue;
          }

          // Non-retryable error — fail immediately
          console.error(`EXTRACT-PDF: Error on attempt ${attempt}:`, err.response?.data || err.message);
          break;
        }
      }

      // All retries exhausted
      console.error("EXTRACT-PDF: All retries failed:", lastError?.response?.data || lastError?.message);
      return res.status(500).json({
        status: "error",
        message: "PDF extraction failed after retries",
        details: lastError?.response?.data?.error?.message || lastError?.message
      });

    } catch (err) {
      console.error("EXTRACT-PDF: Unexpected error:", err.message);
      return res.status(500).json({ status: "error", message: err.message });
    }
  });

  console.log("Extract-PDF API loaded.");
};
