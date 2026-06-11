import logger from './logger.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 15000;

const TIERS = [
    { model: 'google/gemma-4-26b-a4b-it', label: 'gemma-4-26b-a4b' },
    { model: 'bytedance-seed/seed-1.6-flash', label: 'seed-1.6-flash' },
    { model: 'google/gemini-2.5-flash', label: 'gemini-2.5-flash' },
];

async function callOpenRouter(model, prompt, schema, imageBase64, mimeType) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Text-only calls (e.g. bg-prompt refinement) skip the image part so we
    // don't pay encoding cost or force vision routing for a pure text task.
    const content = [{ type: 'text', text: prompt }];
    if (imageBase64 && mimeType) {
        content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } });
    }

    try {
        const res = await fetch(OPENROUTER_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${(process.env.OPENROUTER_API_KEY || '').trim()}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
                'X-Title': 'SnapIT',
            },
            body: JSON.stringify({
                model,
                provider: { require_parameters: true },
                messages: [{ role: 'user', content }],
                response_format: {
                    type: 'json_schema',
                    json_schema: { name: 'marketingCopy', strict: true, schema },
                },
            }),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }

        const json = await res.json();
        const messageContent = json?.choices?.[0]?.message?.content;
        if (!messageContent) throw new Error('empty response content');

        const cleaned = messageContent.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        const data = JSON.parse(cleaned);

        // OpenRouter returns the authoritative per-request cost (USD) + token
        // counts inline in `usage`. This is the ONLY one of our three upstreams
        // that reports cost in-band, so we capture it here and surface it up the
        // cascade for the usage log (see usageLog.js / phase7b_usage.sql).
        const u = json?.usage || {};
        const usage = {
            model: json?.model || model,
            costUsd: typeof u.cost === 'number' ? u.cost : null,
            promptTokens: u.prompt_tokens ?? null,
            completionTokens: u.completion_tokens ?? null,
            requestId: json?.id || null,
        };
        return { data, usage };
    } finally {
        clearTimeout(timer);
    }
}

export async function generateWithCascade(prompt, schema, imageBase64, mimeType) {
    const errors = [];

    for (let i = 0; i < TIERS.length; i++) {
        const { model, label } = TIERS[i];
        const tierNum = i + 1;
        const started = Date.now();

        try {
            const { data, usage } = await callOpenRouter(model, prompt, schema, imageBase64, mimeType);
            const latency = Date.now() - started;
            logger.info({ tier: tierNum, model, latencyMs: latency, costUsd: usage.costUsd }, 'llm.tier_ok');
            // `usage` carries the measured cost/tokens for the usage log. Callers
            // build their own return/HTTP shapes, so this extra key never leaks
            // into a client response.
            return { ...data, provider: label, usage: { ...usage, latencyMs: latency } };
        } catch (err) {
            const latency = Date.now() - started;
            const reason = err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message;
            logger.warn({ tier: tierNum, model, latencyMs: latency, reason }, 'llm.tier_failed — falling through');
            errors.push(`tier${tierNum}(${label}): ${reason}`);

            if (err.status === 401) {
                throw new Error(`OpenRouter auth failed (401) — check OPENROUTER_API_KEY. ${errors.join(' | ')}`);
            }
        }
    }

    throw new Error(`All ${TIERS.length} LLM tiers failed. ${errors.join(' | ')}`);
}
