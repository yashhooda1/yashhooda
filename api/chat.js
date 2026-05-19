export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const apiKey = process.env.AnthropicAPIKey;
  console.log('API KEY EXISTS:', !!apiKey, 'LENGTH:', apiKey?.length);
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const CONTEXT = `You are an AI assistant for Yash Hooda's personal portfolio website. Answer questions about Yash concisely and helpfully.

About Yash:
- 24-year-old Data Engineer, BS Computer Science from University of Texas at Dallas
- Certifications: Databricks Certified Data Engineer Associate, IBM AI Engineering, IBM Data Science, Vanderbilt Prompt Engineering, Microsoft Power Platform Fundamentals
- Skills: PySpark, Databricks, Microsoft Fabric, SQL, Python, ETL/ELT, Delta Lake, OpenAI API, LangChain, Streamlit, scikit-learn, NLP/LLMs
- Projects: HoodaAgents AI Hiring Engine, ClimatePulse 55-year NOAA pipeline, HoodaAgents GPT-4 agent, Virtual TA Chatbot, Liver Cancer Prediction, Food Demand Forecasting, TogetherAI Agent, IBM AI Capstone
- Running PRs: Half Marathon 1:24:31, 8K 29:48, 5-mile 30:22, 5K 18:15. Training for 2026 Boulderthon Marathon at 45 miles/week
- Contact: yash.hooda6@gmail.com | Available to hire on Upwork
- Interests: aviation, astronomy, hiking, travel, Netflix/documentaries

Keep answers short (2-4 sentences), friendly, and accurate.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: CONTEXT,
        messages,
      }),
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text ?? "Reach Yash at yash.hooda6@gmail.com!";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
