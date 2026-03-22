const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

const app = express();
app.use(express.json());

// ── CONFIG
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

const MODEL_ID = "global.anthropic.claude-sonnet-4-6";

// ── Load Sara's prompt from external file
const SARA_SYSTEM_PROMPT = fs.readFileSync("sara_prompt.txt", "utf8");
console.log("Sara prompt loaded successfully.");

// ── AWS Bedrock client
const bedrockClient = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// ── In-memory conversation history per user (phone → messages array)
const conversationHistory = new Map();
const MAX_HISTORY = 20;

function getHistory(phone) {
  if (!conversationHistory.has(phone)) {
    conversationHistory.set(phone, []);
  }
  return conversationHistory.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ── Parse [BOOKING:...] tag from Sara's response
function extractBookingTag(text) {
  const match = text.match(/\[BOOKING:([^\]]+)\]/);
  if (!match) return null;

  const params = {};
  match[1].split(",").forEach(pair => {
    const [key, ...valueParts] = pair.split("=");
    if (key && valueParts.length > 0) {
      params[key.trim()] = valueParts.join("=").trim();
    }
  });

  return params;
}

// ── Strip [BOOKING:...] tag from message text
function stripBookingTag(text) {
  return text.replace(/\[BOOKING:[^\]]+\]/g, "").trim();
}

// ── Send WhatsApp message
async function sendWhatsApp(to, message) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ── Call Make.com webhook and WAIT for JSON response
async function triggerBooking(bookingParams, patientPhone) {
  if (!MAKE_WEBHOOK_URL) {
    console.error("MAKE_WEBHOOK_URL not set");
    return { status: "error" };
  }

  const payload = {
    name: bookingParams.name || "",
    phone: bookingParams.phone || patientPhone,
    requested_time: bookingParams.time || "",
    service: bookingParams.service || "free consultation",
    patient_phone: patientPhone,
    clinic_owner_phone: process.env.CLINIC_OWNER_PHONE || "",
  };

  console.log("Triggering Make.com webhook:", payload);

  try {
    const response = await axios.post(MAKE_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000, // 15 second timeout
    });

    console.log("Make.com response:", response.data);
    return response.data;
  } catch (err) {
    console.error("Make.com error:", err.message);
    return { status: "error" };
  }
}

// ── Call Claude via AWS Bedrock
async function callClaude(userPhone, userMessage) {
  addToHistory(userPhone, "user", userMessage);

  const history = getHistory(userPhone);

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: SARA_SYSTEM_PROMPT }],
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
  const assistantMessage = response.output.message.content[0].text;

  addToHistory(userPhone, "assistant", assistantMessage);

  return assistantMessage;
}

// ── STEP 1: Meta webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── STEP 2: Receive WhatsApp message (POST)
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const userPhone = message.from;
    const userText = message.text.body;

    console.log(`Incoming from ${userPhone}: ${userText}`);

    // ── First call: Sara responds to the patient's message
    const saraResponse = await callClaude(userPhone, userText);
    console.log(`Sara raw response: ${saraResponse}`);

    // ── Check if Sara included a booking tag
    const bookingParams = extractBookingTag(saraResponse);

    if (bookingParams) {
      // ── BOOKING FLOW: don't send Sara's first response, check calendar first
      console.log("Booking detected:", bookingParams);

      // Call Make.com and WAIT for the result
      const makeResult = await triggerBooking(bookingParams, userPhone);
      console.log("Calendar result:", makeResult);

      // Inject the result into the conversation as a system message
      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(makeResult)}]`;
      
      // Second call: Sara reads the result and responds naturally
      const finalResponse = await callClaude(userPhone, resultMessage);
      console.log(`Sara final response: ${finalResponse}`);

      const cleanFinal = stripBookingTag(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

    } else {
      // ── NORMAL FLOW: no booking, send response directly
      const cleanResponse = stripBookingTag(saraResponse);
      if (!cleanResponse) return;

      await sendWhatsApp(userPhone, cleanResponse);
      console.log(`Replied to ${userPhone}: ${cleanResponse}`);
    }

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sara v2 running on port ${PORT}`));
