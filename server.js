const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── CONFIG ── fill these in on Render as environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;         // sellora123
const WA_TOKEN = process.env.WA_TOKEN;                 // Meta access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // 967413439796424
const VF_API_KEY = process.env.VF_API_KEY;             // Voiceflow API key
const VF_VERSION = "production";

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
  res.sendStatus(200); // acknowledge immediately

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const userPhone = message.from;
    const userText = message.text.body;

    console.log(`Incoming from ${userPhone}: ${userText}`);

    // ── STEP 3: Send to Voiceflow
    const vfResponse = await axios.post(
      `https://general-runtime.voiceflow.com/state/user/${userPhone}/interact`,
      {
        action: { type: "text", payload: userText },
        config: { tts: false, stripSSML: true }
      },
      {
        headers: {
          Authorization: VF_API_KEY,
          versionID: VF_VERSION,
          "Content-Type": "application/json"
        }
      }
    );

    // ── STEP 4: Extract text replies from Voiceflow
    const replies = vfResponse.data
      .filter(t => t.type === "text" && t.payload?.message)
      .map(t => t.payload.message);

    if (replies.length === 0) return;

    const botReply = replies.join("\n\n");

    // ── STEP 5: Send reply back to WhatsApp
    await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: userPhone,
        type: "text",
        text: { body: botReply }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`Replied to ${userPhone}: ${botReply}`);
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bridge running on port ${PORT}`));
