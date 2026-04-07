// ══════════════════════════════════════════════════════════════
// ── PDF SERVICE — Text Extraction from Dental Clinic PDFs
// ── Uses AWS Bedrock Claude for intelligent PDF reading
// ── Part of Phase D-V2 (Command Center)
// ══════════════════════════════════════════════════════════════

const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

const CLAUDE_MODEL_ID = "global.anthropic.claude-sonnet-4-6";

// Minimum characters to consider extraction successful (scanned image trap)
const MIN_EXTRACTED_CHARS = 50;

/**
 * Initialize PDF service with shared Bedrock client
 */
function createPdfService({ bedrockClient }) {

  /**
   * Extract text from a PDF using Claude on Bedrock
   * @param {string} pdfBase64 - Base64-encoded PDF content
   * @returns {object} { text, char_count } or throws on failure
   */
  async function extractTextFromPdf(pdfBase64) {
    if (!pdfBase64) throw new Error("No PDF data provided");

    const command = new ConverseCommand({
      modelId: CLAUDE_MODEL_ID,
      messages: [
        {
          role: "user",
          content: [
            {
              document: {
                name: "clinic_menu",
                format: "pdf",
                source: {
                  bytes: Buffer.from(pdfBase64, "base64"),
                },
              },
            },
            {
              text: `أنت مساعد متخصص في استخراج بيانات العيادات. استخرج جميع المعلومات من هذا الملف بالضبط كما هي.

اكتب النتيجة بالتنسيق التالي بالعربية:

الخدمات والأسعار:
- [اسم الخدمة]: [السعر بالعملة المذكورة]
(كرر لكل خدمة)

الأطباء:
- [اسم الطبيب] — [التخصص]
(كرر لكل طبيب)

معلومات إضافية:
[أي معلومات أخرى مهمة مثل العروض، ساعات العمل، الموقع، إلخ]

قواعد مهمة:
- انقل الأسعار بالضبط كما هي (لا تحول العملات)
- إذا كان النص بالإنجليزية أو الفرنسية، ترجم أسماء الخدمات للعربية مع الحفاظ على الأسعار كما هي
- لا تضف أي معلومات من عندك — فقط ما هو موجود في الملف
- إذا لم تستطع قراءة الملف أو كان صورة ممسوحة ضوئياً بدون نص واضح، اكتب فقط: "لا يمكن قراءة الملف"`,
            },
          ],
        },
      ],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0,
      },
    });

    const response = await bedrockClient.send(command);
    const extractedText = response.output.message.content[0].text;

    return {
      text: extractedText,
      char_count: extractedText.length,
    };
  }

  /**
   * Validate extraction result — scanned image trap (D-V2-2)
   * @param {string} text - Extracted text from PDF
   * @returns {object} { valid: boolean, reason?: string }
   */
  function validateExtraction(text) {
    if (!text || text.length < MIN_EXTRACTED_CHARS) {
      return {
        valid: false,
        reason: "scanned_image",
        message: "The PDF appears to be a scanned image with no readable text. Please upload a text-based PDF or convert the image using an OCR tool first.",
      };
    }

    if (text.includes("لا يمكن قراءة الملف")) {
      return {
        valid: false,
        reason: "unreadable",
        message: "Claude could not read the contents of this PDF. It may be a scanned image, encrypted, or corrupted.",
      };
    }

    return { valid: true };
  }

  /**
   * Determine tier based on text length (D-V2-3)
   * @param {number} charCount - Length of extracted text
   * @returns {string} "basic" or "enterprise"
   */
  function detectTier(charCount) {
    return charCount <= 50000 ? "basic" : "enterprise";
  }

  return {
    extractTextFromPdf,
    validateExtraction,
    detectTier,
    MIN_EXTRACTED_CHARS,
  };
}

module.exports = { createPdfService };
