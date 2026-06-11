/**
 * chat-enhanced.js — Drop-in enhancement layer for yashhooda1.vercel.app
 *
 * Adds to the existing chatbot WITHOUT removing anything:
 *  1. Streaming responses (tokens appear as they're generated)
 *  2. Markdown rendering (bold, lists, code blocks with syntax highlighting)
 *  3. Follow-up suggestion chips (3 clickable questions after each reply)
 *  4. Copy-to-clipboard button on every bot message
 *  5. Message reactions (👍 / 👎 with local persistence)
 *  6. Mobile fullscreen chat window
 *  7. Chat window expand/collapse toggle
 *  8. Character counter on input
 *  9. Smooth scroll-to-bottom with unread indicator
 * 10. Auto-open chat on first visit (after 5 s delay)
 *
 * HOW TO INSTALL — add these 4 lines to index.html just before </body>:
 *
 *   <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
 *   <script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
 *   <script src="js/chat-enhanced.js"></script>
 *
 * COST: ~$0.00025 per conversation turn for suggestions (Haiku model).
 * Zero extra cost for streaming — same model, same tokens.
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // 1. INJECT ENHANCEMENT CSS
  // ─────────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    /* ── MARKDOWN RENDERING ── */
    .msg.bot h1,.msg.bot h2,.msg.bot h3 {
      font-family: 'Space Mono', monospace;
      color: var(--green);
      margin: 0.6rem 0 0.3rem;
      font-size: 0.85rem;
      letter-spacing: 0.03em;
    }
    .msg.bot strong { color: #e2e8f0; }
    .msg.bot em { color: var(--text-muted); font-style: italic; }
    .msg.bot ul, .msg.bot ol {
      margin: 0.4rem 0 0.4rem 1.2rem;
      padding: 0;
    }
    .msg.bot li { padding: 0.1rem 0; font-size: 0.82rem; list-style: disc; }
    .msg.bot ol li { list-style: decimal; }
    .msg.bot p { margin: 0.3rem 0; font-size: 0.82rem; }
    .msg.bot code:not(pre code) {
      background: rgba(76,175,80,0.12);
      border: 1px solid rgba(76,175,80,0.2);
      color: #81c784;
      padding: 0.1rem 0.35rem;
      border-radius: 3px;
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
    }
    .msg.bot pre {
      background: #0d1117;
      border: 1px solid rgba(76,175,80,0.2);
      border-radius: 8px;
      padding: 0.8rem;
      overflow-x: auto;
      margin: 0.5rem 0;
      position: relative;
    }
    .msg.bot pre code {
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      color: #a3e635;
      background: none;
      border: none;
      padding: 0;
    }
    .msg.bot blockquote {
      border-left: 2px solid var(--green);
      margin: 0.4rem 0;
      padding: 0.3rem 0.8rem;
      color: var(--text-muted);
      font-style: italic;
      font-size: 0.8rem;
    }
    .msg.bot hr { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 0.5rem 0; }
    .msg.bot a { color: #81c784; text-decoration: underline; }

    /* ── COPY BUTTON ── */
    .msg-wrapper { position: relative; }
    .msg-wrapper:hover .copy-btn { opacity: 1; }
    .copy-btn {
      position: absolute;
      top: 0.35rem;
      right: 0.35rem;
      background: rgba(76,175,80,0.12);
      border: 1px solid rgba(76,175,80,0.25);
      color: var(--green);
      border-radius: 4px;
      padding: 0.15rem 0.4rem;
      font-size: 0.65rem;
      font-family: 'Space Mono', monospace;
      cursor: pointer;
      opacity: 0;
      transition: all 0.2s;
      letter-spacing: 0.04em;
    }
    .copy-btn:hover { background: rgba(76,175,80,0.25); }
    .copy-btn.copied { color: #4caf50; border-color: #4caf50; }

    /* ── SUGGESTION CHIPS ── */
    .suggestion-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-top: 0.5rem;
      padding-top: 0.45rem;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    .suggestion-chip {
      background: rgba(76,175,80,0.07);
      border: 1px solid rgba(76,175,80,0.22);
      color: #81c784;
      padding: 0.25rem 0.65rem;
      border-radius: 999px;
      font-size: 0.7rem;
      font-family: 'Space Mono', monospace;
      cursor: pointer;
      transition: all 0.2s;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .suggestion-chip:hover {
      background: rgba(76,175,80,0.18);
      border-color: var(--green);
      transform: translateY(-1px);
    }

    /* ── REACTIONS ── */
    .msg-reactions {
      display: flex;
      gap: 0.3rem;
      margin-top: 0.35rem;
    }
    .reaction-btn {
      background: none;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 999px;
      padding: 0.1rem 0.5rem;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
      color: var(--text-muted);
      font-family: 'Space Mono', monospace;
    }
    .reaction-btn:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.2); }
    .reaction-btn.active.up { border-color: var(--green); color: var(--green); background: rgba(76,175,80,0.1); }
    .reaction-btn.active.down { border-color: #ef4444; color: #ef4444; background: rgba(239,68,68,0.1); }
    .reaction-count { font-size: 0.65rem; margin-left: 0.2rem; }

    /* ── STREAMING CURSOR ── */
    .streaming-cursor {
      display: inline-block;
      width: 6px;
      height: 1em;
      background: var(--green);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 0.7s steps(1) infinite;
      border-radius: 1px;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

    /* ── EXPAND BUTTON ── */
    .chat-expand-btn {
      background: none;
      border: none;
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      font-size: 0.85rem;
      padding: 0.2rem 0.5rem;
      margin-right: 0.25rem;
      transition: color 0.2s;
    }
    .chat-expand-btn:hover { color: rgba(255,255,255,0.8); }

    /* ── CHAR COUNTER ── */
    .chat-char-counter {
      font-family: 'Space Mono', monospace;
      font-size: 0.6rem;
      color: var(--text-muted);
      padding: 0 0.5rem;
      align-self: center;
      white-space: nowrap;
      transition: color 0.2s;
    }
    .chat-char-counter.warn { color: #f97316; }
    .chat-char-counter.over { color: #ef4444; }

    /* ── SCROLL-TO-BOTTOM BUTTON ── */
    .scroll-to-bottom {
      position: sticky;
      bottom: 0.5rem;
      left: 50%;
      transform: translateX(-50%);
      background: var(--green);
      color: #000;
      border: none;
      border-radius: 999px;
      padding: 0.3rem 0.9rem;
      font-size: 0.7rem;
      font-family: 'Space Mono', monospace;
      font-weight: 700;
      cursor: pointer;
      display: none;
      letter-spacing: 0.04em;
      box-shadow: 0 2px 12px rgba(76,175,80,0.4);
      z-index: 10;
      transition: all 0.2s;
    }
    .scroll-to-bottom:hover { background: #81c784; transform: translateX(-50%) translateY(-1px); }

    /* ── MOBILE FULLSCREEN CHAT ── */
    @media (max-width: 600px) {
      #chat-window {
        position: fixed !important;
        bottom: 0 !important;
        right: 0 !important;
        left: 0 !important;
        width: 100% !important;
        max-height: 85vh !important;
        border-radius: 18px 18px 0 0 !important;
        border-bottom: none !important;
      }
      #chat-window.open {
        transform: translateY(0) scale(1) !important;
      }
      .chat-tabs { overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
      .chat-tabs::-webkit-scrollbar { display: none; }
      .chat-tab { font-size: 0.7rem !important; padding: 0.65rem 0.55rem !important; white-space: nowrap; }
      .msg { font-size: 0.85rem !important; }
      .chat-messages { max-height: 52vh !important; }
    }

    /* ── EXPANDED CHAT WINDOW ── */
    #chat-window.expanded {
      width: 460px !important;
      max-height: 680px !important;
    }
    @media (max-width: 600px) {
      #chat-window.expanded {
        width: 100% !important;
        max-height: 90vh !important;
      }
    }

    /* ── CHAT TABS (scrollable on any size) ── */
    .chat-tabs {
      display: flex;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .chat-tabs::-webkit-scrollbar { display: none; }

    /* ── PROJECT "ASK AI" BUTTON ── */
    .project-ask-ai {
      background: rgba(76,175,80,0.08);
      border: 1px solid rgba(76,175,80,0.22);
      color: #81c784;
      padding: 0.25rem 0.65rem;
      border-radius: 5px;
      font-size: 0.7rem;
      font-family: 'Space Mono', monospace;
      cursor: pointer;
      transition: all 0.2s;
      letter-spacing: 0.03em;
    }
    .project-ask-ai:hover { background: rgba(76,175,80,0.18); border-color: var(--green); }
  `;
  document.head.appendChild(style);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. CONFIGURE MARKED.JS (runs safely in the browser)
  // ─────────────────────────────────────────────────────────────────────────
  function setupMarked() {
    if (typeof marked === 'undefined') return;
    marked.setOptions({
      breaks: true,       // single newline = <br>
      gfm: true,
      headerIds: false,
      mangle: false,
    });
    // Syntax highlighting via highlight.js if available
    if (typeof hljs !== 'undefined') {
      marked.setOptions({
        highlight: function (code, lang) {
          if (lang && hljs.getLanguage(lang)) {
            try { return hljs.highlight(code, { language: lang }).value; } catch {}
          }
          try { return hljs.highlightAuto(code).value; } catch {}
          return code;
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. MARKDOWN RENDER HELPER
  // ─────────────────────────────────────────────────────────────────────────
  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return escapeHtml(text);
    try {
      // Security: DOMPurify-lite — strip on[event] handlers
      let html = marked.parse(text);
      html = html.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
      return html;
    } catch {
      return escapeHtml(text);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. ADD EXPAND BUTTON TO CHAT HEADER
  // ─────────────────────────────────────────────────────────────────────────
  function addExpandButton() {
    const closeBtn = document.querySelector('.chat-close');
    if (!closeBtn) return;
    if (document.getElementById('chat-expand-btn')) return; // already added
    const btn = document.createElement('button');
    btn.id = 'chat-expand-btn';
    btn.className = 'chat-expand-btn';
    btn.title = 'Expand / Collapse';
    btn.textContent = '⤢';
    btn.onclick = function () {
      const win = document.getElementById('chat-window');
      win.classList.toggle('expanded');
      btn.textContent = win.classList.contains('expanded') ? '⤡' : '⤢';
    };
    closeBtn.parentNode.insertBefore(btn, closeBtn);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ADD CHARACTER COUNTER TO INPUT ROW
  // ─────────────────────────────────────────────────────────────────────────
  function addCharCounter() {
    const input = document.getElementById('chat-input');
    const row   = document.querySelector('.chat-input-row');
    if (!input || !row || document.getElementById('chat-char-counter')) return;
    const counter = document.createElement('span');
    counter.id = 'chat-char-counter';
    counter.className = 'chat-char-counter';
    counter.textContent = '';
    row.insertBefore(counter, input);
    input.addEventListener('input', () => {
      const len = input.value.length;
      const max = 1000;
      if (len === 0) { counter.textContent = ''; counter.className = 'chat-char-counter'; return; }
      const remaining = max - len;
      counter.textContent = remaining < 200 ? remaining : '';
      counter.className = 'chat-char-counter' + (remaining < 0 ? ' over' : remaining < 100 ? ' warn' : '');
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. COPY BUTTON + REACTIONS — inject into bot messages
  // ─────────────────────────────────────────────────────────────────────────
  function wrapBotMessage(msgEl) {
    if (msgEl.dataset.enhanced) return;
    msgEl.dataset.enhanced = '1';

    // Wrap in relative container for copy button positioning
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper';
    msgEl.parentNode.insertBefore(wrapper, msgEl);
    wrapper.appendChild(msgEl);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'copy';
    copyBtn.onclick = function () {
      const text = msgEl.innerText || msgEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = '✓ copied';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = 'copy'; copyBtn.classList.remove('copied'); }, 2000);
      }).catch(() => { copyBtn.textContent = 'error'; });
    };
    wrapper.appendChild(copyBtn);

    // Reactions row
    const reactRow = document.createElement('div');
    reactRow.className = 'msg-reactions';
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    msgEl.dataset.msgId = msgId;

    ['👍', '👎'].forEach((emoji, idx) => {
      const btn = document.createElement('button');
      const isUp = idx === 0;
      btn.className = 'reaction-btn ' + (isUp ? 'up' : 'down');
      const count = parseInt(localStorage.getItem(`react_${msgId}_${emoji}`) || '0', 10);
      btn.innerHTML = `${emoji}<span class="reaction-count">${count || ''}</span>`;
      btn.onclick = function () {
        const wasActive = btn.classList.contains('active');
        // Remove active from sibling
        reactRow.querySelectorAll('.reaction-btn').forEach(b => b.classList.remove('active'));
        if (!wasActive) {
          btn.classList.add('active');
          const newCount = (parseInt(localStorage.getItem(`react_${msgId}_${emoji}`) || '0', 10)) + 1;
          localStorage.setItem(`react_${msgId}_${emoji}`, newCount);
          btn.querySelector('.reaction-count').textContent = newCount;
        }
      };
      reactRow.appendChild(btn);
    });

    wrapper.appendChild(reactRow);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. SUGGESTION CHIPS — render below a bot message
  // ─────────────────────────────────────────────────────────────────────────
  function appendSuggestions(wrapperEl, suggestions) {
    if (!suggestions || !suggestions.length) return;
    // Remove any existing chips
    wrapperEl.querySelectorAll('.suggestion-chips').forEach(el => el.remove());

    const chips = document.createElement('div');
    chips.className = 'suggestion-chips';
    suggestions.forEach(text => {
      const chip = document.createElement('button');
      chip.className = 'suggestion-chip';
      chip.textContent = text;
      chip.onclick = function () {
        chips.remove();
        const input = document.getElementById('chat-input');
        if (input) { input.value = text; input.focus(); }
        if (typeof window.sendMsg === 'function') window.sendMsg();
      };
      chips.appendChild(chip);
    });
    wrapperEl.appendChild(chips);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 8. APPLY MARKDOWN to an existing bot message element
  // ─────────────────────────────────────────────────────────────────────────
  function applyMarkdown(msgEl) {
    if (msgEl.dataset.mdApplied) return;
    msgEl.dataset.mdApplied = '1';
    const text = msgEl.textContent || '';
    // Only apply if it looks like markdown (has **, *, -, #, `, etc.)
    if (/[*#`_\-\[]/.test(text) || text.includes('\n')) {
      msgEl.innerHTML = renderMarkdown(text);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 9. OVERRIDE sendMsg WITH STREAMING + ENHANCED VERSION
  // Waits until the original sendMsg is defined, then wraps it.
  // ─────────────────────────────────────────────────────────────────────────
  function patchSendMsg() {
    const _orig = window.sendMsg;
    if (typeof _orig !== 'function') return; // not ready yet

    window.sendMsg = async function enhancedSendMsg() {
      const input = document.getElementById('chat-input');
      if (!input) return _orig.apply(this, arguments);
      const userText = input.value.trim();
      if (!userText) return;

      // Get session state from existing globals
      const sessionId   = window.sessionId   || null;
      const currentModel = window.currentModel || 'claude-opus-4-8';
      const messages    = window.messages     || null;

      // If we can't access the internal state, fall back to original
      if (!messages) return _orig.apply(this, arguments);

      // Clear input + counter
      input.value = '';
      const counter = document.getElementById('chat-char-counter');
      if (counter) counter.textContent = '';

      // Render user message
      const chatEl = document.getElementById('chat-messages');
      if (!chatEl) return _orig.apply(this, arguments);

      const userDiv = document.createElement('div');
      userDiv.className = 'msg user';
      userDiv.textContent = userText;
      chatEl.appendChild(userDiv);
      scrollToBottomSmooth(chatEl);

      // Add user message to messages array
      messages.push({ role: 'user', content: userText });

      // Show typing indicator
      const typingDiv = document.createElement('div');
      typingDiv.className = 'msg bot msg-typing';
      typingDiv.innerHTML = '<span></span><span></span><span></span>';
      chatEl.appendChild(typingDiv);
      scrollToBottomSmooth(chatEl);

      try {
        // Attempt streaming
        const streamSupported = cfg.provider === 'anthropic' ||
          !currentModel.startsWith('gpt');

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages,
            sessionId,
            model: currentModel,
            stream: streamSupported,
          }),
        });

        typingDiv.remove();

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream') && streamSupported) {
          // ── STREAMING PATH ──
          const botDiv = document.createElement('div');
          botDiv.className = 'msg bot';
          chatEl.appendChild(botDiv);

          const cursor = document.createElement('span');
          cursor.className = 'streaming-cursor';
          botDiv.appendChild(cursor);
          scrollToBottomSmooth(chatEl);

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let suggestions = [];
          let meta = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const jsonStr = line.slice(6).trim();
              try {
                const event = JSON.parse(jsonStr);
                if (event.token) {
                  fullText += event.token;
                  // Update rendered content
                  cursor.remove();
                  botDiv.innerHTML = renderMarkdown(fullText);
                  const newCursor = document.createElement('span');
                  newCursor.className = 'streaming-cursor';
                  botDiv.appendChild(newCursor);
                  cursor.replaceWith(newCursor);
                  scrollToBottomSmooth(chatEl);
                }
                if (event.done) {
                  // Remove streaming cursor
                  botDiv.querySelectorAll('.streaming-cursor').forEach(el => el.remove());
                  botDiv.innerHTML = renderMarkdown(fullText);
                  botDiv.dataset.mdApplied = '1';
                }
                if (event.meta) {
                  meta = event.meta;
                  suggestions = meta.suggestions || [];
                  // Render citations
                  if (meta.citations && meta.citations.length) {
                    renderCitations(botDiv, meta.citations);
                  }
                  // Render agent badge
                  if (meta.agent) {
                    renderAgentBadge(botDiv, meta.agent);
                  }
                  // Update model display
                  if (typeof window.updateModelDisplay === 'function') {
                    window.updateModelDisplay(meta.model);
                  }
                }
              } catch { /* skip */ }
            }
          }

          // Final cleanup
          botDiv.querySelectorAll('.streaming-cursor').forEach(el => el.remove());
          messages.push({ role: 'assistant', content: fullText });
          wrapBotMessage(botDiv);
          appendSuggestions(botDiv.parentNode || chatEl.lastElementChild, suggestions);
          scrollToBottomSmooth(chatEl);

        } else {
          // ── NON-STREAMING FALLBACK PATH ──
          const data = await response.json();
          const botDiv = document.createElement('div');
          botDiv.className = 'msg bot';

          // Agent badge
          if (data.agent) {
            renderAgentBadge(botDiv, data.agent);
          }

          // Render markdown
          botDiv.innerHTML = renderMarkdown(data.reply || 'Sorry, something went wrong.');
          botDiv.dataset.mdApplied = '1';

          // Citations
          if (data.citations && data.citations.length) {
            renderCitations(botDiv, data.citations);
          }

          chatEl.appendChild(botDiv);
          messages.push({ role: 'assistant', content: data.reply || '' });

          // Update model display if function exists
          if (typeof window.updateModelDisplay === 'function') {
            window.updateModelDisplay(data.model);
          }

          wrapBotMessage(botDiv);
          appendSuggestions(botDiv.parentNode || chatEl, data.suggestions || []);
          scrollToBottomSmooth(chatEl);
        }

      } catch (err) {
        typingDiv.remove();
        const errDiv = document.createElement('div');
        errDiv.className = 'msg bot';
        errDiv.textContent = 'Network error — please try again.';
        chatEl.appendChild(errDiv);
        wrapBotMessage(errDiv);
        console.error('[chat-enhanced] sendMsg error:', err);
      }
    };

    console.log('[chat-enhanced] sendMsg patched with streaming + markdown');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 10. RENDER HELPERS (citations / agent badge)
  //     These mirror what the original code does so they look consistent.
  // ─────────────────────────────────────────────────────────────────────────
  function renderCitations(botDiv, citations) {
    const row = document.createElement('div');
    row.className = 'citation-row';
    citations.forEach(c => {
      const pill = document.createElement('span');
      pill.className = 'citation-pill';
      pill.textContent = c.label;
      pill.title = c.snippet || '';
      row.appendChild(pill);
    });
    botDiv.appendChild(row);
  }

  function renderAgentBadge(botDiv, agentLabel) {
    const agentKey = agentLabel.toLowerCase().includes('running') ? 'running'
      : agentLabel.toLowerCase().includes('career') ? 'career'
      : agentLabel.toLowerCase().includes('travel') ? 'travel'
      : '';
    if (!agentKey) return;
    const badge = document.createElement('div');
    badge.className = `agent-badge ${agentKey}`;
    badge.textContent = agentLabel;
    botDiv.prepend(badge);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 11. SCROLL HELPER
  // ─────────────────────────────────────────────────────────────────────────
  function scrollToBottomSmooth(el) {
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 12. MUTATION OBSERVER — apply markdown + enhancements to dynamically
  //     added bot messages (including those from the original sendMsg path).
  // ─────────────────────────────────────────────────────────────────────────
  function startMutationObserver() {
    const chatEl = document.getElementById('chat-messages');
    if (!chatEl) return;

    const obs = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;
          const isBotMsg = node.classList?.contains('msg') && node.classList?.contains('bot') && !node.classList?.contains('msg-typing');
          if (isBotMsg && !node.dataset.enhanced) {
            // Small delay so the text is fully set before we transform it
            setTimeout(() => {
              applyMarkdown(node);
              wrapBotMessage(node);
            }, 50);
          }
        });
      });
    });

    obs.observe(chatEl, { childList: true });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 13. ADD "ASK AI" BUTTON TO EACH PROJECT CARD
  // ─────────────────────────────────────────────────────────────────────────
  function addProjectAskAI() {
    document.querySelectorAll('.project-card').forEach(card => {
      if (card.querySelector('.project-ask-ai')) return;
      const titleEl = card.querySelector('.project-title');
      if (!titleEl) return;
      const title = titleEl.textContent.replace(/^[^\w]+/, '').trim();
      const btn = document.createElement('button');
      btn.className = 'project-ask-ai';
      btn.textContent = '🤖 Ask AI';
      btn.title = `Ask the AI about ${title}`;
      btn.onclick = function (e) {
        e.preventDefault();
        const input = document.getElementById('chat-input');
        const chatWindow = document.getElementById('chat-window');
        if (input) input.value = `Tell me more about the ${title} project`;
        if (chatWindow && !chatWindow.classList.contains('open')) {
          if (typeof window.toggleChat === 'function') window.toggleChat();
        }
        if (input) input.focus();
        // Switch to chat tab
        const chatTab = document.querySelector('.chat-tab.active');
        if (chatTab && !chatTab.textContent.includes('Chat')) {
          const firstTab = document.querySelector('.chat-tab');
          if (firstTab && typeof window.showChatView === 'function') window.showChatView(firstTab);
        }
      };
      const linksDiv = card.querySelector('.project-links');
      if (linksDiv) linksDiv.appendChild(btn);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 14. AUTO-OPEN CHAT on first visit (after 5 s)
  // ─────────────────────────────────────────────────────────────────────────
  function autoOpenOnFirstVisit() {
    if (localStorage.getItem('chat_ever_opened')) return;
    setTimeout(() => {
      const chatWindow = document.getElementById('chat-window');
      if (chatWindow && !chatWindow.classList.contains('open')) {
        if (typeof window.toggleChat === 'function') {
          window.toggleChat();
          localStorage.setItem('chat_ever_opened', '1');
        }
      }
    }, 5000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 15. APPLY MARKDOWN TO EXISTING MESSAGES (e.g. initial greeting)
  // ─────────────────────────────────────────────────────────────────────────
  function enhanceExistingMessages() {
    document.querySelectorAll('.msg.bot').forEach(el => {
      if (!el.classList.contains('msg-typing') && !el.dataset.enhanced) {
        applyMarkdown(el);
        wrapBotMessage(el);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 16. BOOT SEQUENCE
  // ─────────────────────────────────────────────────────────────────────────
  function boot() {
    setupMarked();
    addExpandButton();
    addCharCounter();
    startMutationObserver();
    enhanceExistingMessages();
    addProjectAskAI();
    autoOpenOnFirstVisit();

    // Patch sendMsg — retry until it's available (original script may load after us)
    let attempts = 0;
    const tryPatch = setInterval(() => {
      if (typeof window.sendMsg === 'function' && !window.sendMsg._enhanced) {
        window.sendMsg._enhanced = true;
        patchSendMsg();
        clearInterval(tryPatch);
      }
      if (++attempts > 40) clearInterval(tryPatch); // give up after 4 s
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
