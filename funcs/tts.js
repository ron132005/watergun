// ================= POLYFILL =================
if (typeof global.CustomEvent === "undefined") {
  global.CustomEvent = class CustomEvent extends Event {
    constructor(event, params) {
      super(event, params);
      this.detail = params?.detail;
    }
  };
}

// ================= IMPORTS =================
const { Mistral } = require("@mistralai/mistralai");
const { init } = require("@heyputer/puter.js/src/init.cjs");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Agent, setGlobalDispatcher } = require("undici");

// ================= HTTP KEEP-ALIVE =================
// Speeds up repeated API calls significantly
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000,
  })
);

// ================= INIT APIS (ONCE) =================
const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

const puter = init(process.env.PUTER_TOKEN);

// ================= TEMP DIR INIT =================
const tempDir = path.join(__dirname, "..", "temp", "audio");
fs.mkdirSync(tempDir, { recursive: true });

// ================= UTIL: TIMEOUT WRAPPER =================
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout exceeded")), ms)
    ),
  ]);

// ================= MAIN EXPORT =================
module.exports = async function (api, event) {
  if (!event?.body || !event?.threadID) return;

  const { threadID, messageID } = event;
  const query = event.body.replace(/jarvis/gi, "").trim();

  if (!query) {
    return api.sendMessage("⚠️ Please provide a prompt.", threadID, messageID);
  }

  // Unique + collision-safe filename
  const filePath = path.join(
    tempDir,
    `voice_${process.hrtime.bigint()}.mp3`
  );

  const cleanup = () => {
    fs.rm(filePath, { force: true }, () => {});
  };

  try {
    // ================= 1️⃣ AI RESPONSE =================
    const aiResponse = await withTimeout(
      mistral.agents.complete({
        agentId: process.env.MISTRAL_AGENT_ID,
        messages: [{ role: "user", content: query }],
      }),
      20_000
    );

    const replyText =
      aiResponse?.choices?.[0]?.message?.content?.trim();

    if (!replyText) {
      return api.sendMessage(
        "❌ AI returned an empty response.",
        threadID,
        messageID
      );
    }

    // ================= 2️⃣ TTS =================
    const audioObj = await withTimeout(
      puter.ai.txt2speech(replyText, {
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        response_format: "mp3",
      }),
      20_000
    );

    if (!audioObj?.src) {
      throw new Error("No audio source returned.");
    }

    // Native fetch (faster than axios)
    const audioRes = await fetch(audioObj.src);

    if (!audioRes.ok) {
      throw new Error("Audio fetch failed.");
    }

    // Stream directly to disk (no buffering)
    await pipeline(
      audioRes.body,
      fs.createWriteStream(filePath)
    );

    // ================= 3️⃣ SEND =================
    await api.sendMessage(
      {
        body: replyText,
        attachment: fs.createReadStream(filePath),
      },
      threadID,
      messageID
    );

    cleanup();
  } catch (err) {
    console.error("AI/TTS Error:", err.message);

    cleanup();

    // Fallback to text-only
    try {
      await api.sendMessage(
        "⚠️ Voice failed. Sending text only:\n\n" + (err.message || ""),
        threadID,
        messageID
      );
    } catch {
      console.error("Message send failed.");
    }
  }
};
