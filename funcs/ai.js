const { Mistral } = require("@mistralai/mistralai");

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY || "k4jPtVCCTupFcIFqr7BGDfJNmoqgoS8k",
});

module.exports = async function (api, event) {
  const { threadID, messageID, body } = event;

  const query = body.replace(/jarvis/gi, "").trim();

  if (!query) {
    return api.sendMessage("⚠️ Please provide a prompt.", threadID, messageID);
  }

  try {
    const result = await mistral.agents.complete({
      agentId: "ag_019b6bd2a2e674eb8856e455b3125591",
      messages: [
        {
          role: "user",
          content: query,
        },
      ],
    });

    const reply = result.choices?.[0]?.message?.content || "No response.";

    api.sendMessage(reply, threadID, messageID);
  } catch (error) {
    console.error("Error communicating with Mistral:", error);
    api.sendMessage("❌ Error communicating with the AI.", threadID, messageID);
  }
};
