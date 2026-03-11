const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VF_API_KEY = process.env.VF_API_KEY;
const VF_PROJECT_ID = process.env.VF_PROJECT_ID;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// Webhook verification
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Incoming WhatsApp messages
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const userPhone = message.from;
    const userText = message.text.body;

    // Send to Voiceflow
    const vfResponse = await axios.post(
      `https://general-runtime.voiceflow.com/state/user/${userPhone}/interact`,
      {
        action: { type: "text", payload: userText },
        config: { tts: false, stripSSML: true }
      },
      {
        headers: {
          Authorization: VF_API_KEY,
          "Content-Type": "application/json",
          versionID: "production"
        }
      }
    );

    // Extract text replies from Voiceflow
    const traces = vfResponse.data;
    let fullReply = "";

    for (const trace of traces) {
      if (trace.type === "text" && trace.payload?.message) {
        fullReply += trace.payload.message + "\n";
      }
    }

    if (!fullReply.trim()) return;

    // Detect hidden booking tag
    const bookingTagRegex = /\[BOOKING:([^\]]+)\]/;
    const match = fullReply.match(bookingTagRegex);

    if (match && MAKE_WEBHOOK_URL) {
      // Parse booking data from tag
      const tagContent = match[1];
      const bookingData = {};
      tagContent.split(",").forEach(pair => {
        const [key, ...rest] = pair.split("=");
        bookingData[key.trim()] = rest.join("=").trim();
      });

      // Fire Make.com webhook in background
      axios.post(MAKE_WEBHOOK_URL, {
        name: bookingData.name || "",
        phone: bookingData.phone || userPhone,
        requested_time: bookingData.time || "",
        service: bookingData.service || "",
        patient_phone: userPhone,
        clinic_owner_phone: process.env.CLINIC_OWNER_PHONE || userPhone
      }).catch(err => console.error("Make.com webhook error:", err.message));

      // Strip the hidden tag from the visible reply
      fullReply = fullReply.replace(bookingTagRegex, "").trim();
    }

    // Send clean reply to WhatsApp
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: userPhone,
        type: "text",
        text: { body: fullReply.trim() }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
