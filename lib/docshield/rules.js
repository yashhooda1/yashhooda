// lib/docshield/rules.js — rule registry: one place for severity, category and
// framework mappings, so the scanner, the SARIF writer and the docs agree.
//
// Mappings are deliberately conservative: a rule only lists a framework ID
// when the technique genuinely matches what the rule detects.
//   OWASP  = OWASP Top 10 for LLM Applications (2025)
//   ATT&CK = MITRE ATT&CK Enterprise technique
//   ATLAS  = MITRE ATLAS (adversarial ML) technique
//   CWE    = Common Weakness Enumeration

export const SEVERITY_POINTS = { critical: 60, high: 30, medium: 12, low: 4, info: 0 };
export const SEVERITY_ORDER  = ['critical', 'high', 'medium', 'low', 'info'];

const OWASP = {
  LLM01: 'LLM01:2025 Prompt Injection',
  LLM02: 'LLM02:2025 Sensitive Information Disclosure',
  LLM05: 'LLM05:2025 Improper Output Handling',
  LLM07: 'LLM07:2025 System Prompt Leakage',
  LLM10: 'LLM10:2025 Unbounded Consumption',
};
const PI_DIRECT = 'AML.T0051.000 LLM Prompt Injection: Direct';
const PI_INDIRECT = 'AML.T0051.001 LLM Prompt Injection: Indirect';

export const RULES = {
  // ── file type / container ────────────────────────────────────────────────
  'DS-FT-001': { title: 'Declared type does not match file content', severity: 'high', category: 'file-type',
    attack: ['T1036.008 Masquerading: Masquerade File Type'], cwe: ['CWE-434'] },
  'DS-FT-002': { title: 'Executable content uploaded as a document', severity: 'critical', category: 'file-type',
    attack: ['T1204.002 User Execution: Malicious File', 'T1036.008 Masquerading: Masquerade File Type'], cwe: ['CWE-434'] },
  'DS-FT-003': { title: 'Polyglot file (second format hidden inside)', severity: 'high', category: 'file-type',
    attack: ['T1027 Obfuscated Files or Information'], cwe: ['CWE-434'] },
  'DS-FT-004': { title: 'Deceptive filename (double extension or RTL override)', severity: 'high', category: 'file-type',
    attack: ['T1036.007 Masquerading: Double File Extension', 'T1036.002 Masquerading: Right-to-Left Override'], cwe: ['CWE-451'] },
  'DS-FT-005': { title: 'Active content type (HTML / SVG / script)', severity: 'medium', category: 'file-type',
    attack: ['T1204.002 User Execution: Malicious File'], cwe: ['CWE-79'] },

  // ── PDF structure ────────────────────────────────────────────────────────
  'DS-PDF-001': { title: 'PDF contains JavaScript', severity: 'high', category: 'pdf-active-content',
    attack: ['T1204.002 User Execution: Malicious File', 'T1059.007 Command and Scripting Interpreter: JavaScript'], cwe: ['CWE-94'] },
  'DS-PDF-002': { title: 'PDF runs an action automatically on open', severity: 'medium', category: 'pdf-active-content',
    attack: ['T1204.002 User Execution: Malicious File'] },
  'DS-PDF-003': { title: 'PDF Launch action (can start a program)', severity: 'critical', category: 'pdf-active-content',
    attack: ['T1204.002 User Execution: Malicious File'], cwe: ['CWE-78'] },
  'DS-PDF-004': { title: 'PDF carries an embedded file', severity: 'medium', category: 'pdf-active-content',
    attack: ['T1027.009 Obfuscated Files or Information: Embedded Payloads'] },
  'DS-PDF-005': { title: 'Embedded file has an executable extension', severity: 'critical', category: 'pdf-active-content',
    attack: ['T1027.009 Obfuscated Files or Information: Embedded Payloads', 'T1204.002 User Execution: Malicious File'] },
  'DS-PDF-006': { title: 'PDF name obfuscation (#hex escapes in keywords)', severity: 'high', category: 'pdf-evasion',
    attack: ['T1027 Obfuscated Files or Information'] },
  'DS-PDF-007': { title: 'PDF form submits data or uses XFA / RichMedia', severity: 'medium', category: 'pdf-active-content',
    attack: ['T1204.002 User Execution: Malicious File'] },
  'DS-PDF-008': { title: 'PDF is encrypted — content could not be fully inspected', severity: 'medium', category: 'pdf-evasion',
    attack: ['T1027 Obfuscated Files or Information'] },
  'DS-PDF-009': { title: 'PDF modified after creation (incremental updates)', severity: 'low', category: 'pdf-integrity' },
  'DS-PDF-010': { title: 'Decompression bomb / stream exceeds inflate limit', severity: 'high', category: 'resource-exhaustion',
    owasp: [OWASP.LLM10], cwe: ['CWE-409'] },
  'DS-PDF-011': { title: 'Hidden text layer (invisible to a human, visible to an AI)', severity: 'medium', category: 'hidden-content',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT], attack: ['T1027 Obfuscated Files or Information'] },
  'DS-PDF-012': { title: 'Links to external sites', severity: 'info', category: 'pdf-links' },

  // ── prompt injection ─────────────────────────────────────────────────────
  'DS-PI-001': { title: 'Instruction override ("ignore previous instructions")', severity: 'high', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT] },
  'DS-PI-002': { title: 'Chat-role or delimiter spoofing', severity: 'high', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT] },
  'DS-PI-003': { title: 'Text addressed to the AI that reads this document', severity: 'medium', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT] },
  'DS-PI-004': { title: 'Persona hijack / jailbreak phrasing', severity: 'medium', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_DIRECT] },
  'DS-PI-005': { title: 'Data exfiltration channel (markdown image / URL with data)', severity: 'high', category: 'prompt-injection',
    owasp: [OWASP.LLM01, OWASP.LLM05], atlas: [PI_INDIRECT] },
  'DS-PI-006': { title: 'Instruction to hide actions from the user', severity: 'high', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT] },
  'DS-PI-007': { title: 'Attempt to extract the system prompt', severity: 'medium', category: 'prompt-injection',
    owasp: [OWASP.LLM07], atlas: [PI_INDIRECT] },
  'DS-PI-008': { title: 'Output / decision tampering ("report the amount as …", "rank this candidate first")', severity: 'high', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT] },
  'DS-PI-009': { title: 'Tool / agent action coercion', severity: 'medium', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT] },
  'DS-PI-010': { title: 'Prompt injection hidden from human reviewers', severity: 'critical', category: 'prompt-injection',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT], attack: ['T1027 Obfuscated Files or Information'] },

  // ── unicode / encoding evasion ───────────────────────────────────────────
  'DS-UNI-001': { title: 'Unicode tag characters (invisible "ASCII smuggling")', severity: 'critical', category: 'unicode-evasion',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT], attack: ['T1027 Obfuscated Files or Information'] },
  'DS-UNI-002': { title: 'Zero-width characters splitting words', severity: 'medium', category: 'unicode-evasion',
    attack: ['T1027 Obfuscated Files or Information'] },
  'DS-UNI-003': { title: 'Bidirectional text overrides', severity: 'medium', category: 'unicode-evasion',
    attack: ['T1027 Obfuscated Files or Information'], cwe: ['CWE-451'] },
  'DS-UNI-004': { title: 'Mixed-script homoglyph words', severity: 'low', category: 'unicode-evasion',
    attack: ['T1027 Obfuscated Files or Information'] },
  'DS-UNI-005': { title: 'Encoded (base64) instructions', severity: 'high', category: 'unicode-evasion',
    owasp: [OWASP.LLM01], atlas: [PI_INDIRECT], attack: ['T1027 Obfuscated Files or Information'] },

  // ── secrets and personal data ────────────────────────────────────────────
  'DS-SEC-001': { title: 'Cloud / API credential', severity: 'critical', category: 'secrets',
    owasp: [OWASP.LLM02], attack: ['T1552.001 Unsecured Credentials: Credentials In Files'], cwe: ['CWE-798'] },
  'DS-SEC-002': { title: 'Private key material', severity: 'critical', category: 'secrets',
    owasp: [OWASP.LLM02], attack: ['T1552.004 Unsecured Credentials: Private Keys'], cwe: ['CWE-321'] },
  'DS-SEC-003': { title: 'Connection string with embedded password', severity: 'high', category: 'secrets',
    owasp: [OWASP.LLM02], attack: ['T1552.001 Unsecured Credentials: Credentials In Files'], cwe: ['CWE-798'] },
  'DS-SEC-004': { title: 'Session token (JWT)', severity: 'high', category: 'secrets',
    owasp: [OWASP.LLM02], attack: ['T1552.001 Unsecured Credentials: Credentials In Files'], cwe: ['CWE-522'] },
  'DS-SEC-005': { title: 'High-entropy value assigned to a password / key field', severity: 'medium', category: 'secrets',
    owasp: [OWASP.LLM02], attack: ['T1552.001 Unsecured Credentials: Credentials In Files'], cwe: ['CWE-798'] },
  'DS-PII-001': { title: 'U.S. Social Security number', severity: 'high', category: 'pii',
    owasp: [OWASP.LLM02], cwe: ['CWE-359'] },
  'DS-PII-002': { title: 'Payment card number (Luhn-valid)', severity: 'high', category: 'pii',
    owasp: [OWASP.LLM02], cwe: ['CWE-359'] },
  'DS-PII-003': { title: 'Contact details (emails / phone numbers)', severity: 'info', category: 'pii',
    owasp: [OWASP.LLM02], cwe: ['CWE-359'] },
};

export function mappingsFor(ruleId) {
  const r = RULES[ruleId] || {};
  return { owasp: r.owasp || [], attack: r.attack || [], atlas: r.atlas || [], cwe: r.cwe || [] };
}
