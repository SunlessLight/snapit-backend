// Phase-6 stub: pass-through. Phase 7 fills this in with Supabase JWT verification +
// atomic balance decrement against user_tokens. Wired into /api/enhance now so the
// later swap only touches this file, not server.js.
export default function requireToken(req, res, next) {
    next();
}
