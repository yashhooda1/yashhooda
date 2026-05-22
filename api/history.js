// api/history.js
// Handles: save a chat, list saved chats, get a chat, admin view

import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  const { action } = req.query;

  // ── SAVE A CHAT ──
  // POST /api/history?action=save
  // body: { sessionId, title, messages }
  if (req.method === 'POST' && action === 'save') {
    const { sessionId, title, messages } = req.body;
    if (!sessionId || !title || !messages) {
      return res.status(400).json({ error: 'sessionId, title, and messages required' });
    }
    const chatId = `${sessionId}:${Date.now()}`;
    const record = {
      id: chatId,
      sessionId,
      title: title.slice(0, 60),
      messages: messages.slice(-40), // store last 40 messages max
      savedAt: new Date().toISOString(),
    };
    // Store the chat record
    await redis.set(`saved_chat:${chatId}`, JSON.stringify(record));
    // Add to this session's saved chat index
    await redis.lpush(`saved_index:${sessionId}`, chatId);
    await redis.ltrim(`saved_index:${sessionId}`, 0, 19); // max 20 saved chats per user
    // Add to global admin index
    await redis.lpush('admin:all_chats', chatId);
    await redis.ltrim('admin:all_chats', 0, 199); // keep last 200 across all users
    return res.status(200).json({ ok: true, chatId });
  }

  // ── LIST SAVED CHATS FOR A SESSION ──
  // GET /api/history?action=list&sessionId=xxx
  if (req.method === 'GET' && action === 'list') {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const ids = await redis.lrange(`saved_index:${sessionId}`, 0, 19);
    if (!ids || !ids.length) return res.status(200).json({ chats: [] });
    const records = await Promise.all(
      ids.map(async id => {
        const raw = await redis.get(`saved_chat:${id}`);
        if (!raw) return null;
        try {
          const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
          // Return summary only (no full messages) for the list view
          return { id: r.id, title: r.title, savedAt: r.savedAt, messageCount: r.messages?.length || 0 };
        } catch { return null; }
      })
    );
    return res.status(200).json({ chats: records.filter(Boolean) });
  }

  // ── GET A SINGLE SAVED CHAT ──
  // GET /api/history?action=get&chatId=xxx
  if (req.method === 'GET' && action === 'get') {
    const { chatId } = req.query;
    if (!chatId) return res.status(400).json({ error: 'chatId required' });
    const raw = await redis.get(`saved_chat:${chatId}`);
    if (!raw) return res.status(404).json({ error: 'Chat not found' });
    try {
      const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return res.status(200).json({ chat: record });
    } catch { return res.status(500).json({ error: 'Parse error' }); }
  }

  // ── ADMIN: list all chats (requires admin key) ──
  // GET /api/history?action=admin
  // Header: x-admin-key: YOUR_ADMIN_PASSWORD
  if (req.method === 'GET' && action === 'admin') {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const ids = await redis.lrange('admin:all_chats', 0, 199);
    if (!ids || !ids.length) return res.status(200).json({ chats: [] });
    const records = await Promise.all(
      ids.map(async id => {
        const raw = await redis.get(`saved_chat:${id}`);
        if (!raw) return null;
        try {
          const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return {
            id: r.id,
            sessionId: r.sessionId,
            title: r.title,
            savedAt: r.savedAt,
            messageCount: r.messages?.length || 0,
            messages: r.messages, // full messages for admin
          };
        } catch { return null; }
      })
    );
    return res.status(200).json({ chats: records.filter(Boolean) });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
