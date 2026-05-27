export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
 
  const { messages, systemPrompt } = req.body;
 
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }
 
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: systemPrompt || buildSystemPrompt(),
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3, // limit searches per turn to control latency/cost
          },
        ],
        messages,
      }),
    });
 
    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res.status(response.status).json({ error: errText });
    }
 
    const data = await response.json();
 
    // Extract the final text from the response (skip tool_use / tool_result blocks)
    const textBlocks = data.content.filter((b) => b.type === "text");
    const finalText = textBlocks.map((b) => b.text).join("\n\n");
 
    // Extract any web search citations so the frontend can display sources
    const searchResultBlocks = data.content.filter(
      (b) => b.type === "tool_result" || b.type === "web_search_result"
    );
 
    // Build a sources list from tool_use inputs (the queries used)
    const sources = [];
    data.content.forEach((block) => {
      if (block.type === "tool_use" && block.name === "web_search") {
        sources.push({ query: block.input?.query || "" });
      }
    });
 
    return res.status(200).json({
      text: finalText,
      sources,
      stopReason: data.stop_reason,
      usage: data.usage,
    });
  } catch (err) {
    console.error("chat-search handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
 
function buildSystemPrompt() {
  return `You are Yash Hooda's AI assistant embedded in his personal portfolio website. You have access to a web_search tool to find current, real-time information when needed.
 
IDENTITY
- You are knowledgeable about Yash's background: Data Engineer at a startup company, UTD CS grad, IBM AI Engineering & Data Science certified, Databricks Certified, avid runner (5K PR 18:15, HM PR 1:24:31), training for 2026 Boulderthon Marathon
- You can discuss his projects: HoodaAgents AI Hiring Engine, ClimatePulse pipeline, Virtual TA Chatbot, and more.
- You know about his interests in aviation, astronomy, current world events, politics, economy, climate change, etc....
 
WEB SEARCH GUIDELINES
- Use web_search for: current events, disasters, weather events, natural disasters, weather forecast, politics, economy, climate change, recent tech news, live race results, recent AI/ML papers, job market trends, running news, anything time-sensitive
- Always cite your sources naturally in the response (e.g. "According to [source]...")
- For tech topics, prioritize official docs, Anthropic/OpenAI blogs, arXiv, and reputable tech outlets
- For running, prioritize RunningUSA, FloTrack, Strava news
- For current events, use Google news, CNN, CBS News, MSNBC, AP, Wall Street Journal, Washington Post, Fox News
- For weather forecast, use the Weather Channel, accuweather
- Do NOT search for things you already know with confidence
 
MEMORY & SAVED ARTICLES
- When a user asks you to "save", "remember", or "bookmark" something, acknowledge it clearly so the frontend can store it
- Format saved items with a clear marker: [SAVE_ARTICLE: {"title": "...", "url": "...", "summary": "...", "tags": [...]}]
 
TONE
- Sharp, direct, technically literate — no fluff
- Supportive about running and career goals
- Honest about limitations`;
}
