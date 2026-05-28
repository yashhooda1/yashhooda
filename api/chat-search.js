// api/chat-search.js
// Vercel serverless function — Claude with web_search tool
// maxDuration = 60 solves the 504 timeout (Vercel Pro supports up to 300s)
 
export const maxDuration = 60; // seconds — requires Vercel Pro (you already have it)
export const config = { runtime: 'nodejs' };  // ensure Node runtime, not Edge
 
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  const { messages, sessionId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
 
  // ── Build a lean message list (drop heavy image content to save tokens) ──
  const cleanMessages = messages.slice(-10).map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ') || '[image]'
        : String(m.content)
  }));
 
  // ── Set up SSE streaming so the browser gets tokens as they arrive ──
  // This also prevents Vercel from timing out on the *response* side.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
 
  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush(); // force flush for Vercel edge buffering
  };
 
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 2048,                    // up from 1024 — high effort + search needs headroom
          output_config: { effort: 'high' },
          stream: true,
          system: [
            { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }
          ],
          tools: [{
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 4,                       // up from 2 — lets it follow up when results are thin
          }],
          messages: cleanMessages,
       }),
 
    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errText);
      sendEvent({ type: 'error', error: `Anthropic error ${anthropicRes.status}` });
      res.end();
      return;
    }
 
    // ── Parse the SSE stream from Anthropic ──
    let fullText = '';
    let currentSearchQuery = '';
    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
 
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
 
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line
 
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const rawData = line.slice(6).trim();
        if (rawData === '[DONE]') continue;
 
        let evt;
        try { evt = JSON.parse(rawData); } catch { continue; }
 
        switch (evt.type) {
          case 'content_block_start':
            // Detect when web search is being invoked
            if (evt.content_block?.type === 'tool_use' && evt.content_block?.name === 'web_search') {
              sendEvent({ type: 'searching', message: '🔍 Searching the web…' });
            }
            break;
 
          case 'content_block_delta':
            if (evt.delta?.type === 'text_delta') {
              fullText += evt.delta.text;
              // Stream text tokens to the browser in real time
              sendEvent({ type: 'token', text: evt.delta.text });
            }
            // Capture search query from input_json_delta
            if (evt.delta?.type === 'input_json_delta') {
              currentSearchQuery += evt.delta.partial_json || '';
            }
            break;
 
          case 'content_block_stop':
            // Reset query buffer
            currentSearchQuery = '';
            break;
 
          case 'message_stop':
            // Done — send the complete text for save-marker parsing
            sendEvent({ type: 'done', text: fullText });
            break;
 
          case 'error':
            console.error('Anthropic stream error:', evt.error);
            sendEvent({ type: 'error', error: evt.error?.message || 'Stream error' });
            break;
        }
      }
    }
 
    // Fallback done event if message_stop wasn't received
    if (fullText) {
      sendEvent({ type: 'done', text: fullText });
    }
 
  } catch (err) {
    console.error('chat-search handler error:', err);
    sendEvent({ type: 'error', error: err.message });
  }
 
  res.end();
}
 
function buildSystemPrompt() {
  return `You are Yash Hooda's AI assistant on his portfolio website. You have web_search to find current information.
 
IDENTITY: Data Engineer, UTD CS grad, IBM AI Engineering & Data Science certified, Databricks Certified. Runner — 5K PR 18:15, HM PR 1:24:31, training for 2026 Boulderthon Marathon. You can discuss his projects: HoodaAgents AI Hiring Engine, ClimatePulse pipeline, Virtual TA Chatbot, and more.
You know about his interests in aviation, astronomy, current world events, politics, economy, climate change, etc....
 
SEARCH RULES:
- Search for current events, news, weather, history, politics, economy, tech news, job market trends, natural disasters, recent AI/ML releases, race results, anything time-sensitive
- Cite sources naturally: "According to [outlet]..."
- Keep responses concise — 2-4 paragraphs max
- Do NOT search for things you already know
 
SAVE MARKERS: If user says "save this" or "bookmark this", include at end of reply:
[SAVE_ARTICLE: {"title": "...", "url": "...", "summary": "...", "tags": ["tag1","tag2"]}]
 
TONE: Sharp, direct, no fluff. Supportive on career/running goals.`;
}
 
