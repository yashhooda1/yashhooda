// lib/promptTemplates.js
// ══════════════════════════════════════════════════════════════════════════════
// PROMPT & CONTEXT ENGINEERING REGISTRY
// Documents systematic prompting strategies used across yashhooda.ai
// Gap 1 of AI Engineer roadmap: Prompt & Context Engineering
// ══════════════════════════════════════════════════════════════════════════════

export const PROMPT_STRATEGIES = {

  // ── 1. ZERO-SHOT ─────────────────────────────────────────────────────────
  'zero-shot': {
    label:       'Zero-Shot',
    emoji:       '⚡',
    description: 'Direct question with no examples. Fast, works well for clear factual queries.',
    color:       '#4caf50',
    build: (userQuery, context = '') => ({
      system: `You are an expert AI assistant. Answer directly and concisely.${context ? `\n\nCONTEXT:\n${context}` : ''}`,
      user:   userQuery,
    }),
  },

  // ── 2. FEW-SHOT ──────────────────────────────────────────────────────────
  'few-shot': {
    label:       'Few-Shot',
    emoji:       '📚',
    description: 'Provide 2–3 input/output examples before the real query to prime the model.',
    color:       '#3b82f6',
    build: (userQuery, context = '', domain = 'running') => {
      const EXAMPLES = {
        running: [
          { q: 'How do I run a faster 5K?', a: 'Build aerobic base with 4 easy runs/week, add one tempo run at 10K pace, and do 6×400m intervals weekly. Consistency beats intensity.' },
          { q: 'What causes shin splints?', a: 'Too much mileage too fast, hard surfaces, and weak calves. Fix: 10% weekly increase rule, strengthen calves, run on softer surfaces.' },
        ],
        career: [
          { q: 'How do I become a data engineer?', a: 'Master SQL → Python → one cloud platform → Spark/Databricks. Build 2 end-to-end pipeline projects on GitHub. Get Databricks certified.' },
          { q: 'Do I need a master\'s degree for AI Engineering?', a: 'No. Certifications (IBM AI Engineering, DeepLearning.AI) + real deployed projects beat a degree in 2025. Build in public on GitHub.' },
        ],
        general: [
          { q: 'What is RAG?', a: 'Retrieval-Augmented Generation — combine a vector database with an LLM so the model answers from your actual data, not just training.' },
          { q: 'What is a medallion architecture?', a: 'Bronze (raw ingestion) → Silver (cleaned/transformed) → Gold (business-ready aggregates). Standard pattern for lakehouse data quality.' },
        ],
      };
      const examples = EXAMPLES[domain] || EXAMPLES.general;
      const exampleBlock = examples.map((e, i) =>
        `Example ${i + 1}:\nQ: ${e.q}\nA: ${e.a}`
      ).join('\n\n');
      return {
        system: `You are an expert AI assistant. Study these examples, then answer the new question in the same style.${context ? `\n\nCONTEXT:\n${context}` : ''}\n\n${exampleBlock}`,
        user:   userQuery,
      };
    },
  },

  // ── 3. CHAIN-OF-THOUGHT (CoT) ─────────────────────────────────────────────
  'cot': {
    label:       'Chain-of-Thought',
    emoji:       '🔗',
    description: 'Ask the model to reason step-by-step before answering. Best for complex multi-part questions.',
    color:       '#f97316',
    build: (userQuery, context = '') => ({
      system: `You are an expert AI assistant. For every question, first think through it step by step inside <thinking> tags, then give your final answer inside <answer> tags.${context ? `\n\nCONTEXT:\n${context}` : ''}`,
      user:   `${userQuery}\n\nThink step by step before answering.`,
    }),
  },

  // ── 4. XML STRUCTURED OUTPUT ─────────────────────────────────────────────
  'xml-structured': {
    label:       'XML Structured',
    emoji:       '🏗️',
    description: 'Force structured XML output — ideal for parseable data, reports, or consistent formatting.',
    color:       '#a855f7',
    build: (userQuery, context = '') => ({
      system: `You are an expert AI assistant. Always respond in this exact XML format:
<response>
  <summary>One sentence summary</summary>
  <key_points>
    <point>First key point</point>
    <point>Second key point</point>
    <point>Third key point</point>
  </key_points>
  <action_items>
    <action>Specific next step 1</action>
    <action>Specific next step 2</action>
  </action_items>
  <confidence>high|medium|low</confidence>
</response>
${context ? `\nCONTEXT:\n${context}` : ''}`,
      user: userQuery,
    }),
  },

  // ── 5. ROLE-BASED (System Persona) ───────────────────────────────────────
  'role-based': {
    label:       'Role-Based',
    emoji:       '🎭',
    description: 'Assign a specific expert persona to prime domain knowledge and tone.',
    color:       '#ec4899',
    build: (userQuery, context = '', role = 'marathon coach') => ({
      system: `You are a world-class ${role} with 20+ years of experience. You give precise, evidence-based advice tailored to competitive athletes and ambitious professionals. You are direct, warm, and never generic.${context ? `\n\nCONTEXT:\n${context}` : ''}`,
      user:   userQuery,
    }),
  },

  // ── 6. EXTENDED THINKING (Budget-aware) ──────────────────────────────────
  'extended-thinking': {
    label:       'Extended Thinking',
    emoji:       '🧠',
    description: 'Uses Claude\'s extended thinking budget for hardest reasoning tasks. Slower but most thorough.',
    color:       '#06b6d4',
    build: (userQuery, context = '') => ({
      system: `You are an expert AI assistant performing deep analysis.${context ? `\n\nCONTEXT:\n${context}` : ''}`,
      user:   userQuery,
      thinking: { type: 'enabled', budget_tokens: 8000 },
    }),
  },

  // ── 7. PROMPT CACHING (Anthropic cache_control) ───────────────────────────
  'cached': {
    label:       'Prompt Caching',
    emoji:       '⚡📌',
    description: 'Marks the system prompt as ephemeral cache — reduces latency and cost on repeated calls with same context.',
    color:       '#84cc16',
    build: (userQuery, context = '') => ({
      system: `You are an expert AI assistant.${context ? `\n\nCONTEXT:\n${context}` : ''}`,
      user:   userQuery,
      cacheControl: true, // signals api/prompt-lab.js to use cache_control blocks
    }),
  },
};

// ── STRATEGY METADATA for UI rendering ────────────────────────────────────
export const STRATEGY_LIST = Object.entries(PROMPT_STRATEGIES).map(([key, s]) => ({
  key,
  label:       s.label,
  emoji:       s.emoji,
  description: s.description,
  color:       s.color,
}));

// ── DOMAIN OPTIONS ─────────────────────────────────────────────────────────
export const DOMAINS = [
  { key: 'running',  label: '🏃 Running'        },
  { key: 'career',   label: '💼 Career'          },
  { key: 'general',  label: '🤖 General AI/Data' },
];

// ── ROLE OPTIONS ───────────────────────────────────────────────────────────
export const ROLES = [
  { key: 'marathon coach',           label: '🏃 Marathon Coach'          },
  { key: 'senior data engineer',     label: '⚙️ Senior Data Engineer'    },
  { key: 'AI engineering mentor',    label: '🧠 AI Engineering Mentor'   },
  { key: 'career advisor',           label: '💼 Career Advisor'          },
  { key: 'sports nutritionist',      label: '🥗 Sports Nutritionist'     },
];
