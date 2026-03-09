const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VF_API_KEY = process.env.VF_API_KEY;
const VF_VERSION = "development";

// Track which users have already launched
const launchedUsers = new Set();

// ── Voiceflow interact helper
async function vfInteract(userPhone, action) {
  const response = await axios.post(
    `https://general-runtime.voiceflow.com/state/user/${userPhone}/interact`,
    {
      action,
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
  return response.data;
}

// ── Extract text messages from Voiceflow response
function extractReplies(data) {
  return data
    .filter(t => t.type === "text" && t.payload?.message)
    .map(t => t.payload.message);
}

// ── Send WhatsApp message
async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
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

    // If new user, send launch first to initialize the conversation
    if (!launchedUsers.has(userPhone)) {
      console.log(`New user ${userPhone} - sending launch event`);
      const launchData = await vfInteract(userPhone, { type: "launch" });
      const launchReplies = extractReplies(launchData);
      launchedUsers.add(userPhone);

      if (launchReplies.length > 0) {
        await sendWhatsApp(userPhone, launchReplies.join("\n\n"));
        console.log(`Sent launch reply to ${userPhone}`);
      }
    }

    // Send the actual text message
    const textData = await vfInteract(userPhone, { type: "text", payload: userText });
    const replies = extractReplies(textData);

    if (replies.length === 0) {
      console.log(`No text replies from Voiceflow for ${userPhone}`);
      return;
    }

    const botReply = replies.join("\n\n");
    await sendWhatsApp(userPhone, botReply);
    console.log(`Replied to ${userPhone}: ${botReply}`);

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bridge running on port ${PORT}`));
