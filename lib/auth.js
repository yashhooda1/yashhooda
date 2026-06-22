// lib/auth.js
// ══════════════════════════════════════════════════════════════════════════════
// AUTH HELPERS — JWT signing/verification + bcrypt password hashing
// ══════════════════════════════════════════════════════════════════════════════

import jwt    from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = '30d'; // token valid for 30 days
const SALT_ROUNDS = 12;

// ── JWT ───────────────────────────────────────────────────────────────────────
export function signToken(payload) {
    if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token) {
    if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// ── EXTRACT TOKEN FROM REQUEST ────────────────────────────────────────────────
export function extractToken(req) {
    // Check Authorization header first
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    // Fallback to body
    return req.body?.authToken || null;
}

// ── VERIFY REQUEST AUTH — returns user or null ────────────────────────────────
export function getAuthUser(req) {
    const token = extractToken(req);
    if (!token) return null;
    return verifyToken(token);
}

// ── BCRYPT ────────────────────────────────────────────────────────────────────
export async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}

// ── VALIDATION ────────────────────────────────────────────────────────────────
export function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password) {
    if (!password || password.length < 8) return 'Password must be at least 8 characters.';
    if (!/[A-Z]/.test(password))          return 'Password must contain at least one uppercase letter.';
    if (!/[0-9]/.test(password))          return 'Password must contain at least one number.';
    return null; // valid
}

// ── ADMIN CHECK ───────────────────────────────────────────────────────────────
const ADMIN_EMAIL = 'yash.hooda6@gmail.com';

export function isAdminEmail(email) {
    return email?.toLowerCase().trim() === ADMIN_EMAIL;
}
