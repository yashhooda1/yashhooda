# Yash Hooda – Personal Portfolio

Personal portfolio site with an AI chatbot powered by Claude, deployed on Vercel.

---

## Project Structure

```
/
├── index.html          ← Your main portfolio page
├── vercel.json         ← Vercel routing & edge function config
├── api/
│   └── chat.js         ← Edge function: proxies Anthropic API securely
└── images/             ← Your existing hike/run photos (copy these over)
```

---

## Deployment to Vercel

### Step 1 — Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign in → **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-...`) — you'll need it in Step 3

---

### Step 2 — Push to GitHub

If your site is already on GitHub (which it is, via Vercel), replace your repo files with:
- `index.html` (the new version)
- `vercel.json` (new file)
- `api/chat.js` (new file)
- Keep your `images/` folder as-is

```bash
# In your repo root:
git add index.html vercel.json api/chat.js
git commit -m "Add AI chatbot with Vercel edge function"
git push
```

Vercel will auto-redeploy on push.

---

### Step 3 — Add the API Key as an Environment Variable

1. Go to [vercel.com/dashboard](https://vercel.com/dashboard)
2. Click your project → **Settings** → **Environment Variables**
3. Add a new variable:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-...` (your key from Step 1)
   - **Environments:** Production, Preview, Development ✓ (check all three)
4. Click **Save**
5. Go to **Deployments** → click the three dots on the latest deploy → **Redeploy**

---

### Step 4 — Test It

Visit your site and click the 🤖 button in the bottom-right corner. Try asking:
- "What are Yash's top skills?"
- "Tell me about ClimatePulse"
- "What's his half marathon PR?"

---

## How It Works

```
Browser  →  POST /api/chat  →  Edge Function (api/chat.js)
                                    ↓
                              Reads ANTHROPIC_API_KEY
                              from Vercel env vars
                                    ↓
                              POST → api.anthropic.com
                                    ↓
                              Returns { reply: "..." }
                                    ↓
Browser  ←  { reply }  ←────────────
```

**Why an edge function?**  
You can't call the Anthropic API directly from the browser — it would expose your secret API key to anyone who opens DevTools. The edge function keeps the key server-side and only exposes a simple `/api/chat` endpoint.

---

## Local Development

```bash
npm install -g vercel
vercel dev
```

Then open `http://localhost:3000`. The edge function runs locally and reads `ANTHROPIC_API_KEY` from a `.env.local` file:

```
# .env.local  (do NOT commit this file)
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Cost Estimate

The chatbot uses `claude-sonnet-4-20250514` with `max_tokens: 300`.

| Traffic | Estimated Monthly Cost |
|---------|------------------------|
| 100 chats/month | ~$0.10 |
| 1,000 chats/month | ~$1.00 |
| 10,000 chats/month | ~$10.00 |

You can set a spend limit at [console.anthropic.com](https://console.anthropic.com) → **Settings** → **Limits**.

---

## Security Notes

- The `ANTHROPIC_API_KEY` is **never** in the frontend HTML — only in Vercel's encrypted env vars
- The edge function only accepts `POST` requests with a valid `messages` array
- CORS is configured to allow your domain only (update `Access-Control-Allow-Origin` in `api/chat.js` from `*` to your exact domain for extra security, e.g. `https://yashhooda.vercel.app`)
