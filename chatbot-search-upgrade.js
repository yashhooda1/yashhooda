(function () {
  "use strict";
 
  // ─── CONFIG ──────────────────────────────────────────────────────────────
  const SEARCH_API = "/api/chat-search";
  const MEMORY_KEY = "yh_chatbot_memory"; // localStorage key
  const MAX_MEMORY_ITEMS = 50;
 
  // Keywords that trigger the search-enabled endpoint instead of the default
  const SEARCH_TRIGGERS = [
    "latest", "recent", "news", "today", "current", "now", "2025", "2026", "weather", "weather forecast",
    "just announced", "what happened", "search", "find", "look up",
    "article", "paper", "research", "trending", "live", "update",
    "marathon results", "race results", "strava", "pr ", "world record",
  ];
 
  // ─── MEMORY STORE ────────────────────────────────────────────────────────
  const Memory = {
    load() {
      try {
        return JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]");
      } catch {
        return [];
      }
    },
 
    save(items) {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(items.slice(0, MAX_MEMORY_ITEMS)));
    },
 
    add(item) {
      const items = this.load();
      // Deduplicate by URL or title
      const exists = items.some(
        (i) => (item.url && i.url === item.url) || i.title === item.title
      );
      if (!exists) {
        items.unshift({
          ...item,
          id: Date.now(),
          savedAt: new Date().toISOString(),
        });
        this.save(items);
      }
      return items;
    },
 
    remove(id) {
      const items = this.load().filter((i) => i.id !== id);
      this.save(items);
      return items;
    },
 
    clear() {
      localStorage.removeItem(MEMORY_KEY);
      return [];
    },
 
    search(query) {
      const q = query.toLowerCase();
      return this.load().filter(
        (i) =>
          i.title?.toLowerCase().includes(q) ||
          i.summary?.toLowerCase().includes(q) ||
          i.tags?.some((t) => t.toLowerCase().includes(q))
      );
    },
  };
 
  // ─── SEARCH ROUTING ──────────────────────────────────────────────────────
  function needsWebSearch(text) {
    const lower = text.toLowerCase();
    return SEARCH_TRIGGERS.some((trigger) => lower.includes(trigger));
  }
 
  // Intercept outgoing chatbot API calls
  // We patch fetch so that calls to /api/chat are optionally redirected
  const _originalFetch = window.fetch.bind(window);
 
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
 
    // Only intercept the chatbot's chat endpoint
    if (url.includes("/api/chat") && !url.includes("/api/chat-search")) {
      try {
        const body = JSON.parse(init?.body || "{}");
        const lastUserMsg = [...(body.messages || [])]
          .reverse()
          .find((m) => m.role === "user");
        const userText =
          typeof lastUserMsg?.content === "string"
            ? lastUserMsg.content
            : lastUserMsg?.content?.[0]?.text || "";
 
        if (needsWebSearch(userText)) {
          console.log("[chatbot-search] Routing to search endpoint:", SEARCH_API);
          // Swap endpoint, keep same body
          const searchResponse = await _originalFetch(SEARCH_API, init);
          if (searchResponse.ok) {
            const data = await searchResponse.json();
            // Check for article save instructions in the response
            if (data.text) {
              parseSaveInstructions(data.text);
            }
            // Return a Response that matches what your chatbot expects
            return new Response(JSON.stringify(data), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      } catch (e) {
        console.warn("[chatbot-search] Routing error, falling back:", e);
      }
    }
 
    return _originalFetch(input, init);
  };
 
  // ─── ARTICLE SAVE PARSING ────────────────────────────────────────────────
  // The system prompt tells Claude to emit [SAVE_ARTICLE: {...}] markers
  function parseSaveInstructions(text) {
    const regex = /\[SAVE_ARTICLE:\s*(\{.*?\})\]/gs;
    let match;
    while ((match = regex.exec(text)) !== null) {
      try {
        const item = JSON.parse(match[1]);
        Memory.add(item);
        refreshMemoryPanel();
        showSaveToast(item.title || "Article saved");
      } catch (e) {
        console.warn("[chatbot-search] Failed to parse SAVE_ARTICLE:", e);
      }
    }
  }
 
  // Also allow user to manually save by clicking a button in the chat
  window.YH_SaveArticle = function (item) {
    Memory.add(item);
    refreshMemoryPanel();
    showSaveToast(item.title || "Saved");
  };
 
  // ─── TOAST NOTIFICATION ──────────────────────────────────────────────────
  function showSaveToast(title) {
    const existing = document.getElementById("yh-save-toast");
    if (existing) existing.remove();
 
    const toast = document.createElement("div");
    toast.id = "yh-save-toast";
    toast.innerHTML = `💾 Saved: <strong>${escHtml(title)}</strong>`;
    toast.style.cssText = `
      position: fixed; bottom: 90px; right: 20px; z-index: 99999;
      background: #00c851; color: #000; padding: 10px 16px;
      border-radius: 8px; font-family: monospace; font-size: 13px;
      box-shadow: 0 4px 20px rgba(0,200,80,0.4);
      animation: yhFadeIn 0.3s ease;
      max-width: 280px; word-break: break-word;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }
 
  // ─── MEMORY PANEL UI ─────────────────────────────────────────────────────
  function injectMemoryPanel() {
    // Inject global styles
    if (!document.getElementById("yh-memory-styles")) {
      const style = document.createElement("style");
      style.id = "yh-memory-styles";
      style.textContent = `
        @keyframes yhFadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes yhSlideIn { from { opacity:0; transform:translateX(20px) } to { opacity:1; transform:translateX(0) } }
 
        #yh-memory-panel {
          position: fixed;
          bottom: 90px; right: 20px;
          width: 340px; max-height: 520px;
          background: #0d1117;
          border: 1px solid #00c851;
          border-radius: 12px;
          box-shadow: 0 8px 40px rgba(0,200,80,0.15), 0 2px 8px rgba(0,0,0,0.5);
          font-family: 'JetBrains Mono', 'Courier New', monospace;
          font-size: 13px;
          color: #e0e0e0;
          z-index: 9998;
          display: none;
          flex-direction: column;
          animation: yhSlideIn 0.25s ease;
          overflow: hidden;
        }
        #yh-memory-panel.open { display: flex; }
 
        #yh-memory-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px;
          border-bottom: 1px solid #1e3a1e;
          background: #0a1a0a;
        }
        #yh-memory-header h3 {
          margin: 0; font-size: 13px; color: #00c851; letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        #yh-memory-header button {
          background: none; border: none; color: #888; cursor: pointer;
          font-size: 16px; padding: 0; line-height: 1;
        }
        #yh-memory-header button:hover { color: #fff; }
 
        #yh-memory-search {
          margin: 10px 12px 6px;
          padding: 7px 10px;
          background: #161b22;
          border: 1px solid #2a4a2a;
          border-radius: 6px;
          color: #ccc;
          font-family: inherit;
          font-size: 12px;
          outline: none;
          width: calc(100% - 24px);
          box-sizing: border-box;
        }
        #yh-memory-search::placeholder { color: #555; }
        #yh-memory-search:focus { border-color: #00c851; }
 
        #yh-memory-list {
          overflow-y: auto; flex: 1;
          padding: 6px 12px 12px;
          scrollbar-width: thin;
          scrollbar-color: #1e3a1e #0d1117;
        }
 
        .yh-memory-item {
          background: #161b22;
          border: 1px solid #1e3a1e;
          border-radius: 8px;
          padding: 10px 12px;
          margin-bottom: 8px;
          position: relative;
          transition: border-color 0.2s;
        }
        .yh-memory-item:hover { border-color: #00c851; }
 
        .yh-memory-item-title {
          font-weight: 600; color: #00c851;
          margin-bottom: 4px; font-size: 12px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .yh-memory-item-summary {
          color: #999; font-size: 11px; line-height: 1.5;
          display: -webkit-box; -webkit-line-clamp: 2;
          -webkit-box-orient: vertical; overflow: hidden;
        }
        .yh-memory-item-meta {
          display: flex; justify-content: space-between; align-items: center;
          margin-top: 6px;
        }
        .yh-memory-item-date {
          color: #555; font-size: 10px;
        }
        .yh-memory-item-tags {
          display: flex; gap: 4px; flex-wrap: wrap;
        }
        .yh-memory-tag {
          background: #0a2a0a; color: #00c851;
          border: 1px solid #1e3a1e;
          border-radius: 4px; padding: 1px 6px; font-size: 10px;
        }
        .yh-memory-item-actions {
          position: absolute; top: 8px; right: 8px;
          display: none; gap: 4px;
        }
        .yh-memory-item:hover .yh-memory-item-actions { display: flex; }
        .yh-memory-action-btn {
          background: #0a1a0a; border: 1px solid #2a4a2a;
          color: #888; border-radius: 4px; padding: 2px 6px;
          font-size: 10px; cursor: pointer; font-family: inherit;
        }
        .yh-memory-action-btn:hover { color: #fff; border-color: #00c851; }
 
        #yh-memory-empty {
          text-align: center; color: #555; padding: 30px 20px;
          font-size: 12px; line-height: 1.8;
        }
        #yh-memory-empty span { display: block; font-size: 24px; margin-bottom: 8px; }
 
        #yh-memory-footer {
          padding: 8px 12px;
          border-top: 1px solid #1e3a1e;
          background: #0a1a0a;
          display: flex; justify-content: space-between; align-items: center;
        }
        #yh-memory-count { color: #555; font-size: 11px; }
        #yh-memory-clear {
          background: none; border: 1px solid #3a1a1a;
          color: #8a4a4a; border-radius: 4px; padding: 3px 8px;
          font-size: 11px; cursor: pointer; font-family: inherit;
        }
        #yh-memory-clear:hover { border-color: #ff4a4a; color: #ff4a4a; }
 
        #yh-memory-fab {
          position: fixed; bottom: 20px; right: 76px;
          width: 48px; height: 48px;
          background: #0d1117;
          border: 2px solid #00c851;
          border-radius: 50%;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          font-size: 20px;
          box-shadow: 0 4px 16px rgba(0,200,80,0.2);
          z-index: 9997;
          transition: all 0.2s;
          color: #00c851;
        }
        #yh-memory-fab:hover {
          background: #00c851; color: #000;
          box-shadow: 0 4px 24px rgba(0,200,80,0.4);
          transform: scale(1.05);
        }
        #yh-memory-fab .yh-mem-badge {
          position: absolute; top: -4px; right: -4px;
          background: #ff4500; color: #fff;
          border-radius: 50%; width: 16px; height: 16px;
          font-size: 9px; display: none;
          align-items: center; justify-content: center;
          font-weight: 700; border: 2px solid #0d1117;
        }
        #yh-memory-fab .yh-mem-badge.visible { display: flex; }
      `;
      document.head.appendChild(style);
    }
 
    // FAB button to toggle panel
    if (!document.getElementById("yh-memory-fab")) {
      const fab = document.createElement("button");
      fab.id = "yh-memory-fab";
      fab.title = "Saved Articles & Events";
      fab.innerHTML = `📚<span class="yh-mem-badge" id="yh-mem-badge"></span>`;
      fab.addEventListener("click", toggleMemoryPanel);
      document.body.appendChild(fab);
    }
 
    // Memory panel
    if (!document.getElementById("yh-memory-panel")) {
      const panel = document.createElement("div");
      panel.id = "yh-memory-panel";
      panel.innerHTML = `
        <div id="yh-memory-header">
          <h3>📚 Saved Memory</h3>
          <button onclick="document.getElementById('yh-memory-panel').classList.remove('open')" title="Close">✕</button>
        </div>
        <input id="yh-memory-search" type="text" placeholder="Search saved items…" autocomplete="off" />
        <div id="yh-memory-list"></div>
        <div id="yh-memory-footer">
          <span id="yh-memory-count">0 items</span>
          <button id="yh-memory-clear">Clear All</button>
        </div>
      `;
      document.body.appendChild(panel);
 
      // Search input
      document.getElementById("yh-memory-search").addEventListener("input", (e) => {
        renderMemoryList(e.target.value.trim());
      });
 
      // Clear all
      document.getElementById("yh-memory-clear").addEventListener("click", () => {
        if (confirm("Clear all saved articles and events?")) {
          Memory.clear();
          refreshMemoryPanel();
        }
      });
    }
 
    refreshMemoryPanel();
  }
 
  function toggleMemoryPanel() {
    const panel = document.getElementById("yh-memory-panel");
    if (panel) panel.classList.toggle("open");
  }
 
  function refreshMemoryPanel() {
    const query = document.getElementById("yh-memory-search")?.value?.trim() || "";
    renderMemoryList(query);
    updateBadge();
  }
 
  function renderMemoryList(query = "") {
    const list = document.getElementById("yh-memory-list");
    const countEl = document.getElementById("yh-memory-count");
    if (!list) return;
 
    const items = query ? Memory.search(query) : Memory.load();
 
    if (items.length === 0) {
      list.innerHTML = `<div id="yh-memory-empty">
        <span>🔍</span>
        ${query ? `No results for "<strong>${escHtml(query)}</strong>"` : `No saved articles yet.<br>Ask the chatbot to search for<br>news or events, then say<br>"save this" to bookmark it.`}
      </div>`;
    } else {
      list.innerHTML = items
        .map(
          (item) => `
        <div class="yh-memory-item" data-id="${item.id}">
          <div class="yh-memory-item-title" title="${escHtml(item.title || "")}">
            ${item.url ? `<a href="${escHtml(item.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${escHtml(item.title || "Untitled")}</a>` : escHtml(item.title || "Untitled")}
          </div>
          ${item.summary ? `<div class="yh-memory-item-summary">${escHtml(item.summary)}</div>` : ""}
          <div class="yh-memory-item-meta">
            <span class="yh-memory-item-date">${formatDate(item.savedAt)}</span>
            <div class="yh-memory-item-tags">
              ${(item.tags || []).map((t) => `<span class="yh-memory-tag">${escHtml(t)}</span>`).join("")}
            </div>
          </div>
          <div class="yh-memory-item-actions">
            ${item.url ? `<button class="yh-memory-action-btn" onclick="window.open('${escHtml(item.url)}','_blank')">Open</button>` : ""}
            <button class="yh-memory-action-btn" onclick="YH_RemoveMemoryItem(${item.id})">Remove</button>
          </div>
        </div>`
        )
        .join("");
    }
 
    if (countEl) {
      const total = Memory.load().length;
      countEl.textContent = `${total} item${total !== 1 ? "s" : ""} saved`;
    }
  }
 
  function updateBadge() {
    const badge = document.getElementById("yh-mem-badge");
    if (!badge) return;
    const count = Memory.load().length;
    badge.textContent = count > 9 ? "9+" : count;
    badge.classList.toggle("visible", count > 0);
  }
 
  window.YH_RemoveMemoryItem = function (id) {
    Memory.remove(id);
    refreshMemoryPanel();
  };
 
  // ─── ALSO: intercept chatbot text responses to parse save commands ────────
  // If your chatbot uses a function like appendBotMessage(text) or similar,
  // we wrap it to also scan for [SAVE_ARTICLE:...] markers.
  function patchBotMessageAppender() {
    const fnNames = [
      "appendBotMessage",
      "addBotMessage",
      "renderBotMessage",
      "displayMessage",
    ];
    for (const name of fnNames) {
      if (typeof window[name] === "function") {
        const _orig = window[name].bind(window);
        window[name] = function (...args) {
          const text = args[0];
          if (typeof text === "string") {
            parseSaveInstructions(text);
          }
          return _orig(...args);
        };
        console.log(`[chatbot-search] Patched ${name} for save detection`);
        break;
      }
    }
  }
 
  // ─── HELPERS ─────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
 
  function formatDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return "";
    }
  }
 
  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    console.log("[chatbot-search] Initializing YH Search + Memory upgrade…");
    injectMemoryPanel();
    patchBotMessageAppender();
 
    // Expose public API for manual use in chatbot UI
    window.YH_Memory = Memory;
    window.YH_ParseSave = parseSaveInstructions;
 
    console.log("[chatbot-search] Ready. Memory items:", Memory.load().length);
  }
 
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
 
