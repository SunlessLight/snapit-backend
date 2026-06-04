import { supabaseAdmin } from './supabaseAdmin.js';
import logger from './logger.js';

// Token metering. All three call Postgres RPCs (see supabase/phase7_tokens.sql)
// so the decrement is atomic — the WHERE balance > 0 guard lives in the DB, not
// here, which is what makes concurrent requests safe.

/**
 * Atomically consume one credit. Returns the new balance, or `null` when the
 * user has none left (caller should respond 402). The RPC self-heals a missing
 * row to the trial default before decrementing.
 */
export async function consumeCredit(userId) {
    const { data, error } = await supabaseAdmin.rpc('consume_credit', { p_user_id: userId });
    if (error) {
        logger.error({ err: error, userId }, 'credits.consume.failed');
        throw new Error('CREDIT_RPC_FAILED');
    }
    return data; // integer (new balance) or null (out of credits)
}

/**
 * Refund one credit after a paid upstream call failed. Best-effort: we log and
 * swallow errors rather than masking the original failure with a refund error.
 */
export async function refundCredit(userId) {
    if (!userId) return;
    const { error } = await supabaseAdmin.rpc('refund_credit', { p_user_id: userId });
    if (error) {
        // Logged so it can be reconciled manually if the DB was unreachable.
        logger.error({ err: error, userId }, 'credits.refund.failed');
    }
}

/** Read the current balance (lazily provisioning the trial row if absent). */
export async function getBalance(userId) {
    const { data, error } = await supabaseAdmin.rpc('get_or_init_balance', { p_user_id: userId });
    if (error) {
        logger.error({ err: error, userId }, 'credits.balance.failed');
        throw new Error('CREDIT_RPC_FAILED');
    }
    return data;
}
