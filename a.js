// Speed and reliability optimizations by Claude

const fs = require("fs").promises;
const fsSync = require("fs");
const login = require("@dongdev/fca-unofficial");
const path = require("path");
const axios = require("axios");
const express = require("express");

// --- EXPRESS SERVER SETUP ---
const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_, res) => res.send("Bot is running!"));
app.listen(port, () => console.log(`Server is listening on port ${port}`));
// ----------------------------

// --- SELF-PING TO PREVENT RENDER FREE TIER SPIN-DOWN ---
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
setInterval(
  () => {
    axios.get(`${SELF_URL}/health`).catch(() => {});
  },
  10 * 60 * 1000,
); // Every 10 minutes
// -------------------------------------------------------

// 1. PRE-LOAD COMMANDS
const commands = {
  "/developer": require("./funcs/developer.js"),
  "/song": require("./funcs/song.js"),
  "/lyrics": require("./funcs/lyrics.js"),
  "/tiktok": require("./funcs/tiktok.js"),
  "/image": require("./funcs/image.js"),
  "/help": require("./funcs/help.js"),
  "/accept": require("./funcs/sys/request.js"),
  "/bio": require("./funcs/sys/bio.js"),
  tiktok: require("./funcs/tiktok.js"),
  tts: require("./funcs/tts.js"),
  imganalyzer: require("./funcs/imganalyzer.js"),
};

// 2. CONFIG & CONSTANTS
const TEMP_IMG_DIR = path.join(__dirname, "temp", "img");
const KEYWORDS = ["hulk", "wolverine", "deadpool", "wakanda", "avengers"];
const UNSAFE_CHARS = /[<>:"/\\|?*]/g;
const FIFO_LIMIT = 10;

// --- SCHEDULED CLEANUP: Delete images older than 24 hours, every 6 hours ---
setInterval(
  async () => {
    try {
      const threads = await fs.readdir(TEMP_IMG_DIR);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const thread of threads) {
        const threadDir = path.join(TEMP_IMG_DIR, thread);
        const files = await fs.readdir(threadDir);
        for (const file of files) {
          const filePath = path.join(threadDir, file);
          const { mtimeMs } = await fs.stat(filePath);
          if (mtimeMs < cutoff) await fs.unlink(filePath);
        }
      }
      console.log("Scheduled cleanup complete.");
    } catch (e) {
      console.error("Cleanup error:", e.message);
    }
  },
  6 * 60 * 60 * 1000,
);
// --------------------------------------------------------------------------

async function handlePhotoAttachment(event) {
  const photo = event.attachments.find((att) => att.type === "photo");
  if (!photo) return;

  const { threadID, messageID } = event;
  const sanitizedID = messageID.replace(UNSAFE_CHARS, "_");
  const dirPath = path.join(TEMP_IMG_DIR, threadID);
  const filePath = path.join(dirPath, `${sanitizedID}.jpg`);

  try {
    await fs.mkdir(dirPath, { recursive: true });

    const files = await fs.readdir(dirPath);

    if (files.length >= FIFO_LIMIT) {
      const fileStats = await Promise.all(
        files.map((f) =>
          fs
            .stat(path.join(dirPath, f))
            .then((s) => ({ name: f, mtimeMs: s.mtimeMs })),
        ),
      );
      const oldest = fileStats.reduce((a, b) =>
        a.mtimeMs < b.mtimeMs ? a : b,
      );
      await fs.unlink(path.join(dirPath, oldest.name));
    }

    const response = await axios({
      url: photo.url,
      method: "GET",
      responseType: "stream",
    });
    await new Promise((resolve, reject) => {
      const writer = fsSync.createWriteStream(filePath);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (e) {
    console.error("Image Save Error:", e.message);
  }
}

// 3. MAIN LOGIN
const appState = process.env.APPSTATE;

// --- LOGIN WITH AUTO-RESTART EVERY 8 HOURS ---
let currentStopListener = null;

function startLogin() {
  if (currentStopListener) {
    try { currentStopListener(); } catch (e) {}
    currentStopListener = null;
  }

  login({ appState }, (err, api) => {
    if (err) return console.error(err);

    api.setOptions({ listenEvents: true, selfListen: false });

    const keywordRegex = new RegExp(KEYWORDS.join("|"), "i");

    // --- SCHEDULE LOGIN RESTART EVERY 8 HOURS ---
    const loginRestartTimer = setTimeout(() => {
      console.log("Restarting login after 8 hours...");
      startLogin();
    }, 8 * 60 * 60 * 1000);
    // --------------------------------------------

    // --- MQTT LISTENER WITH AUTO-RESTART ON FAILURE ---
    function startListening() {
      const stopListener = api.listenMqtt(async (err, event) => {
        if (err) {
          console.error("MQTT error, restarting in 5s:", err);
          setTimeout(startListening, 5000);
          return;
        }

        const body = (event.body || "").toLowerCase();
        const { threadID } = event;

        // Non-blocking image save
        if (event.attachments?.some((a) => a.type === "photo")) {
          handlePhotoAttachment(event);
        }

        // REACTION LOGIC
        if (
          ["message", "message_reply"].includes(event.type) &&
          keywordRegex.test(body)
        ) {
          api.setMessageReaction("❤", event.messageID, threadID);
        }

        // COMMAND HANDLER
        if (body.startsWith("/")) {
          const cmd = body.split(" ")[0];
          if (commands[cmd]) {
            try {
              await commands[cmd](api, event);
            } catch (e) {
              console.error(`Command error [${cmd}]:`, e.message);
              api.sendMessage("❌ Error executing command.", threadID);
            }
            return;
          }
        }

        if (body.includes("tiktok.com")) {
          commands["tiktok"](api, event);
          return;
        }

        // JARVIS LOGIC
        if (body.includes("jarvis")) {
          let ranAnalyzer = false;

          if (event.type === "message_reply" && event.messageReply) {
            const sanitizedID = event.messageReply.messageID.replace(
              UNSAFE_CHARS,
              "_",
            );
            const filePath = path.join(
              TEMP_IMG_DIR,
              threadID,
              `${sanitizedID}.jpg`,
            );

            try {
              await fs.access(filePath, fsSync.constants.R_OK);
              commands["imganalyzer"](api, event);
              ranAnalyzer = true;
            } catch {
              // File doesn't exist or isn't readable — fall through to tts
            }
          }

          if (!ranAnalyzer) {
            commands["tts"](api, event);
          }
        }
      });

      currentStopListener = () => {
        clearTimeout(loginRestartTimer);
        if (typeof stopListener === "function") stopListener();
      };
    }

    startListening();
  });
}

startLogin();
// ----------------------------------------------

// --- EXIT AFTER 5 HOURS (Render will auto-restart) ---
setTimeout(() => {
  console.log("5-hour uptime limit reached. Exiting for clean restart...");
  process.exit(0);
}, 5 * 60 * 60 * 1000);
