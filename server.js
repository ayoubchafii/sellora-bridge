const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VF_API_KEY = process.env.VF_API_KEY;
const VF_PROJECT_ID = process.env.VF_PROJECT_ID;

async function vfInteract(sessionID, request) {
  const response = await axios.post(
    `https://general-runtime.voiceflow.com/v2beta1/predict/${VF_PROJECT_ID}`,
    {
      session: { sessionID },
      request
    },
    {
      headers: {
        Authorization: VF_API_KEY,
        "Content-Type": "application/json"
      }
    }
  );
  return response.data;
}

function extractReplies(data) {
  if (!Array.isArray(data)) return [];
  const replies = [];
  for (const trace of data) {
    if (trace.type === "text" && trace.payload?.message) {
      replies.push(trace.payload.message);
    } else if (trace.type === "speak" && trace.payload?.message) {
      replies.push(trace.payload.message);
    }
  }
  return replies;
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

    const data = await vfInteract(userPhone, { type: "text", payload: userText });
    console.log("VF raw response:", JSON.stringify(data));

    const replies = extractReplies(data);

    if (replies.length === 0) {
      console.log("No replies extracted from VF response");
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
