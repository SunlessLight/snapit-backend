import { supabaseAdmin } from './supabaseAdmin.js';
import logger from './logger.js';

// Per-call upstream-API usage log. One row per paid upstream call (OpenRouter /
// Claid / Photoroom) so real spend can be measured (see supabase/phase7b_usage.sql).
//
// Best-effort by design: a logging failure must NEVER break a paid request or
// mask the real error, so we swallow-and-log here (same pattern as
// refundCredit in credits.js). Nothing awaits the result for control flow.
//
// Only OpenRouter reports cost in-band (openrouter_cost_usd). For Claid &
// Photoroom this row is a call COUNTER — the dollar figure is derived later from
// the provider dashboard decrement ÷ the count here. No dollars are fabricated.

/**
 * Insert one usage row. Accepts the api_usage columns directly. `meta` is
 * stringify-able JSON. Fire-and-forget — callers may `void logUsage(...)`.
 *
 * @param {object} record
 * @param {string|null} record.userId
 * @param {'openrouter'|'claid'|'photoroom'} record.provider
 * @param {string} record.operation
 * @param {boolean} record.success
 * @param {string} [record.model]
 * @param {number} [record.snapitCredits]      our internal credit charged (0 = free)
 * @param {number|null} [record.openrouterCostUsd]
 * @param {number} [record.promptTokens]
 * @param {number} [record.completionTokens]
 * @param {string} [record.requestId]
 * @param {string} [record.jobId]
 * @param {object} [record.meta]
 */
export async function logUsage(record) {
    try {
        const row = {
            user_id: record.userId ?? null,
            provider: record.provider,
            operation: record.operation,
            model: record.model ?? null,
            success: record.success,
            snapit_credits: record.snapitCredits ?? 0,
            openrouter_cost_usd: record.openrouterCostUsd ?? null,
            prompt_tokens: record.promptTokens ?? null,
            completion_tokens: record.completionTokens ?? null,
            request_id: record.requestId ?? null,
            job_id: record.jobId ?? null,
            meta: record.meta ?? null,
        };
        const { error } = await supabaseAdmin.from('api_usage').insert(row);
        if (error) {
            logger.error({ err: error, provider: record.provider, operation: record.operation }, 'usage.log.failed');
        }
    } catch (err) {
        // Never let a logging error propagate into the request path.
        logger.error({ err, provider: record?.provider }, 'usage.log.threw');
    }
}
