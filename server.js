const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VF_API_KEY = process.env.VF_API_KEY;

// Your canvas/version ID from the Voiceflow URL
const VF_VERSION_ID = "64dbb6696a8fab0013dba194";

const launchedUsers = new Set();

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
        versionID: VF_VERSION_ID,
        "Content-Type": "application/json"
      }
    }
  );
  return response.data;
}

function extractReplies(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter(t => t.type === "text" && t.payload?.message)
    .map(t => t.payload.message);
}

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

    if (!launchedUsers.has(userPhone)) {
      console.log(`New user - launching`);
      try {
        const launchData = await vfInteract(userPhone, { type: "launch" });
        const launchReplies = extractReplies(launchData);
        launchedUsers.add(userPhone);
        if (launchReplies.length > 0) {
          await sendWhatsApp(userPhone, launchReplies.join("\n\n"));
          console.log(`Launch reply sent`);
        }
      } catch (e) {
        console.error("Launch error:", JSON.stringify(e.response?.data) || e.message);
      }
    }

    const textData = await vfInteract(userPhone, { type: "text", payload: userText });
    console.log("VF response:", JSON.stringify(textData));
    const replies = extractReplies(textData);

    if (replies.length === 0) {
      console.log("No replies from VF");
      return;
    }

    await sendWhatsApp(userPhone, replies.join("\n\n"));
    console.log(`Replied: ${replies.join(" | ")}`);

  } catch (err) {
    console.error("Error:", JSON.stringify(err.response?.data) || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bridge running on port ${PORT}`));
