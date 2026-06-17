// api/imagine.js — DALL-E 3 image generation
// Triggers: "generate/create/draw/make an image of..."
// Also handles: upload image + describe → generate similar via vision

import { notifyFailure } from './_notify.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, imageBase64, imageMime, sessionId } = req.body;
  if (!prompt && !imageBase64)
    return res.status(400).json({ error: 'prompt or imageBase64 required' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  try {
    let finalPrompt = prompt || '';

    // If an image was uploaded, first describe it with vision then use that as prompt
    if (imageBase64 && imageMime) {
      const visionRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBase64}` } },
              { type: 'text', text: prompt
                ? `The user wants to generate a new image based on this photo. Their instructions: "${prompt}". Write a detailed DALL-E image generation prompt that captures the key visual elements of this image and incorporates their instructions. Return only the prompt, nothing else.`
                : 'Write a detailed DALL-E image generation prompt that recreates the key visual elements of this image in an artistic style. Return only the prompt, nothing else.'
              }
            ]
          }]
        }),
      });
      const visionData = await visionRes.json();
      const described = visionData?.choices?.[0]?.message?.content?.trim();
      if (described) finalPrompt = described;
    }

    // Safety: prepend style guidance so DALL-E doesn't get confused
    const safePrompt = finalPrompt.slice(0, 1000);

    const genRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'dall-e-3-20250311',
        prompt: safePrompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      }),
    });

    const genData = await genRes.json();

    if (!genRes.ok) {
      console.error('[IMAGINE] DALL-E error:', genData);
      await notifyFailure({ route: '/api/imagine', model: 'dall-e-3', error: genData?.error?.message || JSON.stringify(genData).slice(0, 200), userMessage: finalPrompt, sessionId });
      return res.status(502).json({ error: genData?.error?.message || 'Image generation failed' });
    }

    const imageUrl      = genData?.data?.[0]?.url;
    const revisedPrompt = genData?.data?.[0]?.revised_prompt;

    if (!imageUrl) return res.status(502).json({ error: 'No image returned from DALL-E' });

    return res.status(200).json({ imageUrl, revisedPrompt, prompt: safePrompt });

  } catch (err) {
    console.error('[IMAGINE] Error:', err);
    await notifyFailure({ route: '/api/imagine', model: 'dall-e-3', error: err, userMessage: prompt, sessionId });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
