import { createClient } from '@supabase/supabase-js';

// Service-role client. The service_role key bypasses RLS, so this is the only
// thing in the app allowed to read/write user_tokens. It must NEVER be shipped
// to the frontend. We disable session persistence/refresh because the backend
// is stateless and only ever uses this client to (a) validate a user's JWT via
// auth.getUser(token) and (b) call the credit RPCs.
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
    console.error('[boot] FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in snapit-backend/.env (see supabase/README.md).');
    process.exit(1);
}

export const supabaseAdmin = createClient(url, serviceKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
    },
});
