// Allowed MIME types — whitelist only
const ALLOWED_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf', 'text/plain', 'text/csv', 'text/markdown'
]);

// Max file size — 5MB
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

// Max base64 length (base64 is ~33% larger than binary)
const MAX_B64_LENGTH = MAX_SIZE_BYTES * 1.4;

// Dangerous patterns to scan for in file content
const INJECTION_PATTERNS = [
    /<script[\s\S]*?>/i,           // XSS
    /javascript:/i,                 // JS injection
    /__import__/i,                  // Python injection
    /eval\s*\(/i,                  // eval injection
    /exec\s*\(/i,                  // exec injection
    /UNION\s+SELECT/i,             // SQL injection
    /DROP\s+TABLE/i,               // SQL injection
    /\$\{.*\}/,                    // template injection
    /\{\{.*\}\}/,                  // template injection
    /%00/,                         // null byte injection
    /\.\.\/\.\.\/\.\.\//,          // path traversal
];

export function validateFile(file, mimeType, fileName) {
    const errors = [];

    // 1. MIME type whitelist
    if (!ALLOWED_TYPES.has(mimeType)) {
        errors.push(`File type ${mimeType} not allowed`);
    }

    // 2. File size check
    if (file && file.length > MAX_B64_LENGTH) {
        errors.push('File too large — max 5MB');
    }

    // 3. File extension must match MIME type
    const ext = fileName?.split('.').pop()?.toLowerCase();
    const extMimeMap = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'png': 'image/png', 'webp': 'image/webp',
        'gif': 'image/gif', 'pdf': 'application/pdf',
        'txt': 'text/plain', 'csv': 'text/csv',
        'md': 'text/markdown',
    };
    if (ext && extMimeMap[ext] && extMimeMap[ext] !== mimeType) {
        errors.push('File extension does not match content type — possible spoofing');
    }

    // 4. Scan decoded content for injection patterns
    try {
        const decoded = Buffer.from(file, 'base64').toString('utf-8', 0, 10000);
        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(decoded)) {
                errors.push(`Malicious content detected: ${pattern}`);
                break; // one hit is enough to reject
            }
        }
    } catch(e) {
        // Binary files won't decode cleanly — that's fine, skip text scan
    }

    // 5. Filename sanitization
    if (fileName && /[<>:"/\\|?*\x00-\x1f]/.test(fileName)) {
        errors.push('Filename contains illegal characters');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}
