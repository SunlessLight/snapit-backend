import { supabaseAdmin } from '../supabaseAdmin.js';
import logger from '../logger.js';

// Phase 7: real auth gate. Verifies the caller's Supabase JWT (sent as
// `Authorization: Bearer <access_token>`) and attaches the user to req.user.
// It deliberately does NOT consume a credit — metering happens in the route
// handler, after request validation and right before the paid upstream call,
// so we never charge for a request that 400s on validation, and the async
// /api/generate job can refund cleanly if processing later fails.
//
// CORS is not a security boundary (curl bypasses it); this is the real one.
export default async function requireToken(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        if (!token) {
            return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });
        }

        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) {
            return res.status(401).json({ success: false, error: 'AUTH_INVALID' });
        }

        req.user = data.user;
        return next();
    } catch (err) {
        logger.error({ err }, 'auth.unexpected');
        return res.status(401).json({ success: false, error: 'AUTH_INVALID' });
    }
}
