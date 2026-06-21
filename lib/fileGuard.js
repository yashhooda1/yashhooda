// lib/fileGuard.js
// ══════════════════════════════════════════════════════════════════════════════
// FILE VALIDATION — MIME whitelist, size cap, extension spoofing, injection scan
// ══════════════════════════════════════════════════════════════════════════════

// Allowed MIME types — whitelist only
const ALLOWED_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf',
    'text/plain', 'text/csv', 'text/markdown',
]);

// Max file size — 5 MB
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
// Max base64 length (base64 is ~33% larger than binary)
const MAX_B64_LENGTH = MAX_SIZE_BYTES * 1.4;

// Dangerous patterns to scan for in decoded file content
const INJECTION_PATTERNS = [
    /<script[\s\S]*?>/i,          // XSS
    /javascript:/i,                // JS injection
    /__import__/i,                 // Python injection
    /eval\s*\(/i,                  // eval injection
    /exec\s*\(/i,                  // exec injection
    /UNION\s+SELECT/i,             // SQL injection
    /DROP\s+TABLE/i,               // SQL injection
    /\$\{.*?\}/,                   // template injection
    /\{\{.*?\}\}/,                 // template injection
    /%00/,                         // null byte injection
    /\.\.\/\.\.\/\.\.\//,          // path traversal
    /ignore (previous|all|above|prior) instructions/i,  // prompt injection
    /system prompt:/i,             // prompt injection
    /\[system\]/i,                 // prompt injection
    /<\|system\|>/i,               // prompt injection
    /EICAR-STANDARD/,              // EICAR antivirus test string
];

// Extension → expected MIME map
const EXT_MIME_MAP = {
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    png:  'image/png',
    webp: 'image/webp',
    gif:  'image/gif',
    pdf:  'application/pdf',
    txt:  'text/plain',
    csv:  'text/csv',
    md:   'text/markdown',
};

export function validateFile(file, mimeType, fileName) {
    const errors = [];

    // 1. MIME type whitelist
    const mime = (mimeType || '').toLowerCase().trim();
    if (!ALLOWED_TYPES.has(mime)) {
        errors.push(`File type "${mime}" is not allowed.`);
    }

    // 2. File size check (base64 string length)
    if (file && file.length > MAX_B64_LENGTH) {
        const sizeMB = (file.length * 0.75 / 1_048_576).toFixed(1);
        errors.push(`File is too large (≈${sizeMB} MB). Maximum is 5 MB.`);
    }

    // 3. File extension must match declared MIME type
    const ext = fileName?.split('.').pop()?.toLowerCase();
    if (ext && EXT_MIME_MAP[ext] && EXT_MIME_MAP[ext] !== mime) {
        errors.push('File extension does not match content type — possible spoofing.');
    }

    // 4. Filename sanitization
    if (fileName && /[<>:"/\\|?*\x00-\x1f]/.test(fileName)) {
        errors.push('Filename contains illegal characters.');
    }

    // 5. Scan decoded content for injection patterns (first 10 KB only)
    if (file && errors.length === 0) {
        try {
            const decoded = Buffer.from(file, 'base64').toString('utf-8', 0, 10000);
            for (const pattern of INJECTION_PATTERNS) {
                if (pattern.test(decoded)) {
                    errors.push(`Malicious content detected in file.`);
                    break; // one hit is enough to reject
                }
            }
        } catch {
            // Binary files (images/PDFs) won't decode as UTF-8 — that's fine, skip text scan
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}
