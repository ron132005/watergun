// Speed and reliability optimizations by Claude
// --- NODE.JS POLYFILL FOR PUTER.JS ---
if (typeof global.CustomEvent === "undefined") {
  global.CustomEvent = class CustomEvent extends Event {
    constructor(event, params) {
      super(event, params);
      this.detail = params ? params.detail : undefined;
    }
  };
}
// -------------------------------------
const { Mistral } = require("@mistralai/mistralai");
const { init } = require("@heyputer/puter.js/src/init.cjs");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
// Initialize APIs once at module load (not per-request)
const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});
const puter = init(
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0IjoiYXUiLCJ2IjoiMC4wLjAiLCJ1dSI6InhaYXp1QVYxUVZ5ZzUzU1JpYzNDQ0E9PSIsImF1IjoiaWRnL2ZEMDdVTkdhSk5sNXpXUGZhUT09IiwicyI6IjEwMFlCWlIxdWlEVENCSUg2bHhPZWc9PSIsImlhdCI6MTc2NzE1NTY3OH0.is6X4pZD-J671mJiNmJFChB-ZgBzJpvzAgKl4-bpYM4",
);
// Create temp dir once at module load
const tempDir = path.join(__dirname, "..", "temp", "audio");
fs.mkdirSync(tempDir, { recursive: true });
module.exports = async function (api, event) {
  if (!event || !event.body || !event.threadID) {
    console.error("Invalid event structure");
    return;
  }
  const { threadID, messageID, body } = event;
  const query = body.replace(/jarvis/gi, "").trim();
  if (!query) {
    return api.sendMessage("⚠️ Please provide a prompt.", threadID, messageID);
  }
  const filePath = path.join(tempDir, `voice_${Date.now()}.mp3`);
  // Async cleanup helper — no artificial delay needed
  const cleanup = () => {
    fs.rm(filePath, (err) => {
      if (err && err.code !== "ENOENT") console.error("Cleanup error:", err);
    });
  };
  try {
    // --- 1️⃣ Generate Text Response from Mistral ---
    let replyText;
    try {
      const result = await mistral.agents.complete({
        agentId: "ag_019b6bd2a2e674eb8856e455b3125591",
        messages: [{ role: "user", content: query }],
      });
      replyText = result.choices?.[0]?.message?.content;
      if (!replyText) throw new Error("Empty response");
    } catch (aiErr) {
      console.error("Mistral Error:", aiErr);
      return api.sendMessage("❌ AI Service Error.", threadID, messageID);
    }
    // --- 2️⃣ Text-to-Speech via Puter.js ---
    try {
      const audioObj = await puter.ai.txt2speech(replyText, {
        provider: "openai",
        model: "tts-1-hd",
        voice: "alloy",
        response_format: "mp3",
      });
      if (!audioObj?.src) throw new Error("No audio generated");
      // Stream directly to disk instead of buffering in memory
      const audioRes = await axios.get(audioObj.src, {
        responseType: "stream",
        timeout: 10000,
      });
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filePath);
        audioRes.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      // --- 3️⃣ Send message with audio stream ---
      await api.sendMessage(
        {
          body: replyText,
          attachment: fs.createReadStream(filePath),
        },
        threadID,
        messageID,
      );
      cleanup();
    } catch (ttsErr) {
      console.error("TTS pipeline failed, fallback to text:", ttsErr.message);
      cleanup();
      await api.sendMessage(replyText, threadID, messageID);
    }
  } catch (globalErr) {
    console.error("Global Error:", globalErr);
    cleanup();
    api.sendMessage("❌ An unexpected error occurred.", threadID, messageID);
  }
};
