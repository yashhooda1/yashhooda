// api/runway.js — Runway Gen-4 video generation
// Text-to-video AND image-to-video
// Async: submits job → polls until complete (up to 90s)

import { notifyFailure } from './_notify.js';

export const maxDuration = 120;

const RUNWAY_API = 'https://api.dev.runwayml.com/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, imageBase64, imageMime, sessionId } = req.body;
  if (!prompt && !imageBase64)
    return res.status(400).json({ error: 'prompt or imageBase64 required' });

  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RUNWAY_API_KEY not configured' });

  try {
    // ── Build request body ──
    const body = {
      model: 'gen4_turbo',
      ratio: '1280:720',
      duration: 5,                          // 5 seconds, cheapest tier
      promptText: (prompt || '').slice(0, 500),
    };

    // Image-to-video: attach the image as base64 data URI
    if (imageBase64 && imageMime) {
      body.promptImage = `data:${imageMime};base64,${imageBase64}`;
    }

    // ── Submit generation job ──
    const submitRes = await fetch(`${RUNWAY_API}/image_to_video`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(body),
    });

    const submitData = await submitRes.json();

    if (!submitRes.ok) {
      console.error('[RUNWAY] Submit error:', submitData);
      await notifyFailure({ route: '/api/runway', model: 'gen4_turbo', error: submitData?.error || JSON.stringify(submitData).slice(0, 200), userMessage: prompt, sessionId });
      return res.status(502).json({ error: submitData?.error || 'Video generation failed to start' });
    }

    const taskId = submitData?.id;
    if (!taskId) return res.status(502).json({ error: 'No task ID returned from Runway' });

    console.log(`[RUNWAY] Task submitted: ${taskId}`);

    // ── Poll for completion (max 90s, every 4s) ──
    const maxPolls  = 22;
    const pollMs    = 4000;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, pollMs));

      const pollRes = await fetch(`${RUNWAY_API}/tasks/${taskId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'X-Runway-Version': '2024-11-06',
        },
      });
      const pollData = await pollRes.json();
      const status   = pollData?.status;

      console.log(`[RUNWAY] Poll ${i + 1}: ${status}`);

      if (status === 'SUCCEEDED') {
        const videoUrl = pollData?.output?.[0];
        if (!videoUrl) return res.status(502).json({ error: 'No video URL in completed task' });
        return res.status(200).json({ videoUrl, taskId, prompt: body.promptText });
      }

      if (status === 'FAILED') {
        const reason = pollData?.failure || 'Unknown failure';
        await notifyFailure({ route: '/api/runway [FAILED]', model: 'gen4_turbo', error: reason, userMessage: prompt, sessionId });
        return res.status(502).json({ error: `Video generation failed: ${reason}` });
      }
      // PENDING / RUNNING → keep polling
    }

    // Timeout
    return res.status(504).json({ error: 'Video generation timed out after 90 seconds. Try a shorter prompt.' });

  } catch (err) {
    console.error('[RUNWAY] Error:', err);
    await notifyFailure({ route: '/api/runway', model: 'gen4_turbo', error: err, userMessage: prompt, sessionId });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
