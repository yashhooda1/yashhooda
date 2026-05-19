export const config = {
  runtime: 'edge',
};

const CONTEXT = `You are an AI assistant for Yash Hooda's personal portfolio website. Answer questions about Yash concisely and helpfully.

About Yash:
- 24-year-old Data Engineer, BS Computer Science from University of Texas at Dallas
- Certifications: Databricks Certified Data Engineer Associate, IBM AI Engineering, IBM Data Science, Vanderbilt Prompt Engineering, Microsoft Power Platform Fundamentals
- Skills: PySpark, Databricks, Microsoft Fabric, SQL, Python, ETL/ELT, Delta Lake, OpenAI API, LangChain, Streamlit, scikit-learn, NLP/LLMs
- Projects: HoodaAgents AI Hiring Engine (Python/Streamlit/OpenAI), ClimatePulse 55-year NOAA data pipeline, HoodaAgents GPT-4 assistant with LangChain + Tavily, Virtual TA Chatbot (senior capstone), Liver Cancer Prediction ML, Food Demand Forecasting, TogetherAI Agent (LLaMA 3.3 70B), IBM AI Engineering Capstone
- Running PRs: Half Marathon 1:24:31 (2025 Aramco Houston), 8K 29:48, 5-mile 30:22, 5K 18:15. Currently training for 2026 Boulderthon Marathon at 45 miles/week. Last race: 2026 NYCRuns Brooklyn Experience HM 1:27:41
- AI tools mastered: ChatGPT-4o, Gemini 2.5 Flash, Grok-3, Microsoft CoPilot, Claude Sonnet 4, Perplexity, DeepSeek R1, Meta AI Llama 4 Maverick
- Contact: yash.hooda6@gmail.com | LinkedIn: linkedin.com/in/yash-hooda-384430242 | GitHub: github.com/yashhooda1
- Available to hire on Upwork: upwork.com/freelancers/~01d69d754fc4bf488e
- Built TARS: custom GPT-4 AI assistant available at the TARS link on his site
- Hike: Solo hiked Lake Monarch loop in Arapaho National Forest, Granby CO (4.07 mi, 335 ft gain)
- Interests: aviation, astronomy, hiking, travel, Netflix/documentaries, family & friends

Keep answers short (2-4 sentences), friendly, and accurate. If asked something not covered, direct them to yash.hooda6@gmail.com.`;

export default async function handler(req) {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // CORS headers — update origin to your actual Vercel domain
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const { messages } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages array is required' }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const apiKey = process.env.AnthropicAPIKey ?? globalThis.AnthropicAPIKey;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
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

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error('Anthropic API error:', err);
      return new Response(JSON.stringify({ error: 'Upstream API error' }), {
        status: 502,
        headers: corsHeaders,
      });
    }

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text ?? "I'm not sure — reach Yash at yash.hooda6@gmail.com!";

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
