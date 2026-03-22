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
const CANCEL_WEBHOOK_URL = process.env.CANCEL_WEBHOOK_URL;
const CLINIC_OWNER_PHONE = process.env.CLINIC_OWNER_PHONE || "";

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

// ── Parse [CANCEL:...] tag from Sara's response
function extractCancelTag(text) {
  const match = text.match(/\[CANCEL:([^\]]+)\]/);
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

// ── Parse [RESCHEDULE:...] tag from Sara's response
function extractRescheduleTag(text) {
  const match = text.match(/\[RESCHEDULE:([^\]]+)\]/);
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

// ── Strip all hidden tags from message text
function stripAllTags(text) {
  return text
    .replace(/\[BOOKING:[^\]]+\]/g, "")
    .replace(/\[CANCEL:[^\]]+\]/g, "")
    .replace(/\[RESCHEDULE:[^\]]+\]/g, "")
    .trim();
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

// ── Send clinic owner notification
async function notifyClinicOwner(type, details) {
  if (!CLINIC_OWNER_PHONE) {
    console.log("No CLINIC_OWNER_PHONE set, skipping notification");
    return;
  }

  let message = "";

  if (type === "new_booking") {
    message = `موعد جديد:\nالاسم: ${details.name}\nالهاتف: ${details.phone}\nالخدمة: ${details.service}\nالوقت: ${details.time}`;
  } else if (type === "cancelled") {
    message = `تم إلغاء موعد:\nالاسم: ${details.name}\nالهاتف: ${details.phone}`;
  } else if (type === "rescheduled") {
    message = `تم تغيير موعد:\nالاسم: ${details.name}\nالهاتف: ${details.phone}\nالخدمة: ${details.service}\nمن: ${details.old_time}\nإلى: ${details.new_time}`;
  }

  if (!message) return;

  try {
    await sendWhatsApp(CLINIC_OWNER_PHONE, message);
    console.log(`Clinic owner notified: ${type}`);
  } catch (err) {
    console.error("Clinic notification error:", err.message);
  }
}

// ── Call Make.com BOOKING webhook and WAIT for JSON response
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
    clinic_owner_phone: CLINIC_OWNER_PHONE,
  };

  console.log("Triggering BOOKING webhook:", payload);

  try {
    const response = await axios.post(MAKE_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    console.log("Booking response:", response.data);
    return response.data;
  } catch (err) {
    console.error("Booking webhook error:", err.message);
    return { status: "error" };
  }
}

// ── Call Make.com CANCEL webhook and WAIT for JSON response
async function triggerCancel(cancelParams, patientPhone) {
  if (!CANCEL_WEBHOOK_URL) {
    console.error("CANCEL_WEBHOOK_URL not set");
    return { status: "error" };
  }

  const payload = {
    name: cancelParams.name || "",
    phone: cancelParams.phone || patientPhone,
    current_utc: new Date().toISOString().replace("Z", "+00:00"),
  };

  console.log("Triggering CANCEL webhook:", payload);

  try {
    const response = await axios.post(CANCEL_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    console.log("Cancel response:", response.data);
    return response.data;
  } catch (err) {
    console.error("Cancel webhook error:", err.message);
    return { status: "error" };
  }
}

// ── Handle RESCHEDULE: cancel old → book new → if fail → re-book old
async function triggerReschedule(rescheduleParams, patientPhone) {

  // Step 1: Cancel the old appointment first
  console.log("RESCHEDULE Step 1: Cancelling old appointment...");
  const cancelParams = {
    name: rescheduleParams.name || "",
    phone: rescheduleParams.phone || patientPhone,
  };
  const cancelResult = await triggerCancel(cancelParams, patientPhone);

  // If no appointment found, stop
  if (cancelResult.status === "not_found") {
    console.log("RESCHEDULE failed: no existing appointment found.");
    return { status: "not_found" };
  }

  // If cancel errored, stop
  if (cancelResult.status === "error") {
    console.log("RESCHEDULE failed: cancel error.");
    return { status: "error" };
  }

  // Save old event details for potential re-booking
  const oldTime = cancelResult.old_time || "";
  const oldService = cancelResult.old_service || "appointment";
  console.log(`Old appointment saved: time=${oldTime}, service=${oldService}`);

  // Step 2: Book the new time
  console.log("RESCHEDULE Step 2: Booking new time...");
  const bookingParams = {
    name: rescheduleParams.name || "",
    phone: rescheduleParams.phone || patientPhone,
    time: rescheduleParams.new_time || "",
    service: rescheduleParams.service || oldService,
  };
  const bookResult = await triggerBooking(bookingParams, patientPhone);

  // If new time booked successfully, done!
  if (bookResult.status === "booked") {
    console.log("RESCHEDULE complete: new time booked successfully.");
    return {
      status: "rescheduled",
      old_time: oldTime,
      new_time: rescheduleParams.new_time,
      service: rescheduleParams.service || oldService,
    };
  }

  // Step 3: New time failed — re-book the old time to restore it (SILENT — no notification)
  console.log(`RESCHEDULE Step 3: New time failed (${bookResult.status}). Re-booking old time...`);

  const rebookParams = {
    name: rescheduleParams.name || "",
    phone: rescheduleParams.phone || patientPhone,
    time: oldTime,
    service: rescheduleParams.service || oldService,
  };
  const rebookResult = await triggerBooking(rebookParams, patientPhone);
  console.log(`Re-book old time result: ${rebookResult.status}`);

  if (bookResult.status === "busy") {
    return { status: "reschedule_failed_busy", rebookSilent: true };
  }

  if (bookResult.status === "outside_hours") {
    return { status: "reschedule_failed_outside_hours", rebookSilent: true };
  }

  return { status: "error" };
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

    // ── Check which tag Sara included
    const bookingParams = extractBookingTag(saraResponse);
    const cancelParams = extractCancelTag(saraResponse);
    const rescheduleParams = extractRescheduleTag(saraResponse);

    if (bookingParams) {
      // ── BOOKING FLOW
      console.log("Booking detected:", bookingParams);
      const makeResult = await triggerBooking(bookingParams, userPhone);
      console.log("Calendar result:", makeResult);

      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(makeResult)}]`;
      const finalResponse = await callClaude(userPhone, resultMessage);
      const cleanFinal = stripAllTags(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

      // Notify clinic owner for successful bookings only
      if (makeResult.status === "booked") {
        await notifyClinicOwner("new_booking", {
          name: bookingParams.name,
          phone: bookingParams.phone || userPhone,
          service: bookingParams.service || "free consultation",
          time: bookingParams.time,
        });
      }

    } else if (cancelParams) {
      // ── CANCEL FLOW
      console.log("Cancel detected:", cancelParams);
      const cancelResult = await triggerCancel(cancelParams, userPhone);
      console.log("Cancel result:", cancelResult);

      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(cancelResult)}]`;
      const finalResponse = await callClaude(userPhone, resultMessage);
      const cleanFinal = stripAllTags(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

      // Notify clinic owner for successful cancellations only
      if (cancelResult.status === "cancelled") {
        await notifyClinicOwner("cancelled", {
          name: cancelParams.name,
          phone: cancelParams.phone || userPhone,
        });
      }

    } else if (rescheduleParams) {
      // ── RESCHEDULE FLOW
      console.log("Reschedule detected:", rescheduleParams);
      const rescheduleResult = await triggerReschedule(rescheduleParams, userPhone);
      console.log("Reschedule result:", rescheduleResult);

      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(rescheduleResult)}]`;
      const finalResponse = await callClaude(userPhone, resultMessage);
      const cleanFinal = stripAllTags(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

      // Notify clinic owner for successful reschedules only — NOT for failed re-books
      if (rescheduleResult.status === "rescheduled") {
        await notifyClinicOwner("rescheduled", {
          name: rescheduleParams.name,
          phone: rescheduleParams.phone || userPhone,
          service: rescheduleParams.service || rescheduleResult.service,
          old_time: rescheduleResult.old_time,
          new_time: rescheduleParams.new_time,
        });
      }
      // Failed reschedule (re-book) → NO notification. Nothing changed for the clinic.

    } else {
      // ── NORMAL FLOW: no tags, send response directly
      const cleanResponse = stripAllTags(saraResponse);
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
