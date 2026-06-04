import 'dotenv/config';

if (!process.env.OPENROUTER_API_KEY) {
    console.error('[boot] FATAL: OPENROUTER_API_KEY is not set. Did you start the server from snapit-backend/?');
    process.exit(1);
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'crypto';
import pinoHttp from 'pino-http';
import { generateMarketingCopy, processImageBackground, enhanceImageWithClaid, refineMarketingCopy, refineBackgroundPrompt } from './services.js';
import requireToken from './middleware/requireToken.js';
import { consumeCredit, refundCredit, getBalance } from './credits.js';
import logger from './logger.js';

const app = express();
const port = process.env.PORT || 3000;

// Job map TTL. Jobs are deleted JOB_TTL_MS after they complete (success or
// failure). The frontend polls /api/status; a 404 from that endpoint is the
// terminal signal that the job has aged out.
const JOB_TTL_MS = 10 * 60 * 1000;
// Multer upload cap. 5MB comfortably covers HEIC-converted JPEGs from modern
// phones after the frontend's browser-image-compression pass.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Comma-separated allowlist from env; localhost dev default. Trailing slashes stripped
// so "https://site.app/" and "https://site.app" are treated the same.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

if (!process.env.FRONTEND_URL) {
    logger.warn('[boot] FRONTEND_URL is not set — only localhost origins are allowed. Set it (comma-separated for multiple) to your Netlify URL in production.');
}

const corsOptions = {
    origin(origin, callback) {
        // No Origin header = same-origin or non-browser client (curl, health checks).
        if (!origin) return callback(null, true);
        const normalized = origin.replace(/\/+$/, '');
        if (allowedOrigins.includes(normalized)) return callback(null, true);
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    // /api/enhance returns a binary body; the new balance rides in this header so
    // the browser must be allowed to read it cross-origin.
    exposedHeaders: ['X-Credit-Balance'],
    optionsSuccessStatus: 200
};
// helmet first so security headers cover every response, including errors.
// crossOriginResourcePolicy is relaxed because /api/enhance serves image bytes
// that the (cross-origin) Netlify frontend fetches.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));

// Coarse per-IP flood guard on the whole API — fires before auth so an
// unauthenticated script can't hammer the box. The real per-user metering is
// the credit balance; this just caps raw request volume.
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error: 'RATE_LIMITED' },
});

// Tighter limiter for the paid routes, keyed by user id once authenticated
// (falls back to IP for unauthenticated callers, who are rejected anyway).
const paidLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip,
    message: { success: false, error: 'RATE_LIMITED' },
});
app.use(pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.url} → ${res.statusCode} (${err?.message || 'error'})`,
    serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
    },
}));
app.use(express.json());
app.use(globalLimiter);

// Only accept actual image uploads. Anything else (PDFs, zips, etc.) is rejected
// before it reaches a paid API. HEIC/HEIF included because some phones upload
// them pre-conversion; the frontend usually converts, but be permissive on input.
const ALLOWED_UPLOAD_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter(req, file, cb) {
        if (ALLOWED_UPLOAD_MIMES.has(file.mimetype)) return cb(null, true);
        cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image'));
    },
});

// Free-text length caps. These fields flow into the LLM prompt, so an
// unbounded value is both a cost and a prompt-injection surface. We truncate
// rather than reject so a slightly-long value never breaks the UX.
const TEXT_CAPS = {
    dishName: 120,
    price: 40,
    description: 1000,
    backgroundDescription: 300,
    changePrompt: 300,
    currentCaption: 4000,
    currentNoteTitle: 200,
    location: 200,
    hours: 200,
    contact: 200,
    originalBackgroundPrompt: 2000,
};
function capBodyText(body) {
    if (!body) return;
    for (const [field, max] of Object.entries(TEXT_CAPS)) {
        if (typeof body[field] === 'string' && body[field].length > max) {
            body[field] = body[field].slice(0, max);
        }
    }
}

const jobs = new Map();

app.post('/api/generate', requireToken, paidLimiter, upload.single('image'), async (req, res) => {
    // 1. Validation phase
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }
    capBodyText(req.body);

    // Extract text fields exactly as your old code did[cite: 1]
    const {
        dishName, price, outputLanguage, backgroundVibe, generateBackground,
        isMediaEditorPro, isContextPro, description, tone, captionLength, backgroundDescription
    } = req.body;
    const shouldGenerateBg = generateBackground === "true";
    const isPro = isContextPro === 'true';
    // In Pro mode the vibe pills are disabled in the UI — the vendor's free-form
    // backgroundDescription is the required signal instead.
    const requiredFields = shouldGenerateBg
        ? (isPro
            ? [dishName, price, outputLanguage, backgroundDescription]
            : [dishName, price, outputLanguage, backgroundVibe])
        : [dishName, price, outputLanguage];


    if (requiredFields.some(field => typeof field !== 'string' || field.trim() === '')) {
        return res.status(400).json({
            success: false,
            error: `Missing required fields. Received: dishName(${dishName}), price(${price}), lang(${outputLanguage}), vibe(${backgroundVibe}), bgDescription(${backgroundDescription})`
        });
    }

    // Pro requires the free-form vendor description. Tone/length are picker-only and
    // always have a Standard default — they're validated via enum below, not non-empty.
    if (isPro && (typeof description !== 'string' || description.trim() === '')) {
        return res.status(400).json({
            success: false,
            error: `Pro context enabled but description is empty. Received: description("${description}")`
        });
    }

    // Enum validation with defensive defaults. Standard mode always sends "casual" /
    // "short"; Pro sends user selection. Old clients (pre-redesign) may send the
    // legacy `tone` enum (funny/luxury/etc) or no `captionLength` at all — we
    // accept those by falling back to the Standard defaults rather than 400-ing.
    const ALLOWED_TONES = new Set(['casual', 'punchy', 'polished', 'playful']);
    const ALLOWED_LENGTHS = new Set(['short', 'medium', 'long']);
    if (typeof tone !== 'string' || !ALLOWED_TONES.has(tone)) {
        req.body.tone = 'casual';
    }
    if (typeof captionLength !== 'string' || !ALLOWED_LENGTHS.has(captionLength)) {
        req.body.captionLength = 'short';
    }

    if (isMediaEditorPro === 'true') {
        logger.info({ dishName }, 'pro media editor enabled');
    }

    // 2. Metering — consume one credit now (atomic). If processJob later fails
    //    we refund it there, so the user is only charged for work we deliver.
    let balance;
    try {
        balance = await consumeCredit(req.user.id);
    } catch {
        return res.status(503).json({ success: false, error: 'Service temporarily unavailable.' });
    }
    if (balance === null) {
        return res.status(402).json({ success: false, error: 'OUT_OF_CREDITS' });
    }

    // 3. Job Creation phase
    const jobId = crypto.randomUUID();
    jobs.set(jobId, { status: 'processing', data: null, error: null });

    // 4. Immediate Response (balance lets the frontend update the pill at once)
    res.status(202).json({ success: true, jobId, balance, message: 'Job accepted. Begin polling.' });

    // 5. Asynchronous Processing (Do not await). userId so a failure can refund.
    processJob(jobId, req.file, req.body, req.user.id);
});

app.post('/api/enhance', requireToken, paidLimiter, upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }

    let balance;
    try {
        balance = await consumeCredit(req.user.id);
    } catch {
        return res.status(503).json({ success: false, error: 'Service temporarily unavailable.' });
    }
    if (balance === null) {
        return res.status(402).json({ success: false, error: 'OUT_OF_CREDITS' });
    }

    const abortController = new AbortController();
    const started = Date.now();
    const enhanceLog = logger.child({ route: 'enhance', size: req.file.size, mime: req.file.mimetype });
    enhanceLog.info('enhance.start');

    try {
        const enhancedBuffer = await enhanceImageWithClaid(req.file.buffer, req.file.mimetype, abortController.signal);
        enhanceLog.info({ ms: Date.now() - started, outBytes: enhancedBuffer.length }, 'enhance.done');
        // Binary body — surface the new balance via a header (CORS-exposed above).
        res.set('Content-Type', 'image/jpeg').set('X-Credit-Balance', String(balance)).send(enhancedBuffer);
    } catch (error) {
        abortController.abort();
        await refundCredit(req.user.id); // didn't deliver — don't charge
        // Log the upstream detail server-side; return a generic message to the client.
        const detail = error.response?.data?.toString?.() || error.message || 'Enhance failed';
        enhanceLog.error({ err: error, ms: Date.now() - started }, `enhance.failed: ${detail}`);
        res.status(502).json({ success: false, error: 'Enhancement failed. Please try again.' });
    }
});

// Assistive-mode caption regen. Sync — user is sitting on the Review screen.
// Re-sends image instead of relying on the jobs Map so the loop's lifetime is
// not coupled to the 10-min TTL.
// Auth-gated but free: caption regen is an LLM-only call (no Claid/Photoroom
// credit), so it requires a valid token but does NOT consume a credit.
app.post('/api/regenerate/captions', requireToken, paidLimiter, upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }
    capBodyText(req.body);
    const {
        dishName, price, outputLanguage, tone, captionLength,
        isContextPro, description, platform, location, hours, contact,
        currentCaption, currentNoteTitle, changePrompt
    } = req.body;

    if (!dishName || !price || !outputLanguage) {
        return res.status(400).json({ success: false, error: 'dishName, price, outputLanguage are required.' });
    }

    const started = Date.now();
    const log = logger.child({ route: 'regenerate.captions', dish: dishName, platform });
    log.info('regen.captions.start');

    try {
        const result = await refineMarketingCopy(
            req.file.buffer,
            req.file.mimetype,
            { dishName, price, outputLanguage, isContextPro, description, tone, captionLength, platform, location, hours, contact },
            { caption: currentCaption, noteTitle: currentNoteTitle },
            changePrompt
        );
        log.info({ ms: Date.now() - started, provider: result.provider }, 'regen.captions.done');
        res.status(200).json({
            success: true,
            caption: result.caption,
            // Present only when platform === 'xiaohongshu'
            noteTitle: result.noteTitle,
        });
    } catch (error) {
        log.error({ err: error, ms: Date.now() - started }, `regen.captions.failed: ${error.message}`);
        res.status(502).json({ success: false, error: 'Caption regeneration failed. Please try again.' });
    }
});

// Assistive-mode background regen. Always runs on the ORIGINAL food image
// (frontend sends mediaState.originalFile, not the previously bg-swapped output)
// so artifacts don't compound across iterations.
app.post('/api/regenerate/background', requireToken, paidLimiter, upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }
    capBodyText(req.body);
    const { originalBackgroundPrompt, changePrompt, seedMode, lastSeed } = req.body;
    if (!originalBackgroundPrompt) {
        return res.status(400).json({ success: false, error: 'originalBackgroundPrompt is required.' });
    }

    // Photoroom call — meter it. Consumed after validation so a bad request
    // never costs a credit; refunded in the catch if Photoroom fails.
    let balance;
    try {
        balance = await consumeCredit(req.user.id);
    } catch {
        return res.status(503).json({ success: false, error: 'Service temporarily unavailable.' });
    }
    if (balance === null) {
        return res.status(402).json({ success: false, error: 'OUT_OF_CREDITS' });
    }

    // Phase 6.7.4 — seedMode controls whether we replay last call's seed
    // ("Tweak this one" — same composition, prompt-driven nudge) or pick a
    // fresh random uint32 ("New variation"). Invalid lastSeed silently falls
    // back to vary so a missing/stale value doesn't 400 the regen.
    const parsedLastSeed = lastSeed !== undefined ? parseInt(lastSeed, 10) : NaN;
    const shouldFixSeed = seedMode === 'fix' && Number.isInteger(parsedLastSeed) && parsedLastSeed >= 0;
    const seedOption = shouldFixSeed ? { seed: parsedLastSeed } : undefined;

    const abortController = new AbortController();
    const started = Date.now();
    const log = logger.child({ route: 'regenerate.background', seedMode: shouldFixSeed ? 'fix' : 'vary' });
    log.info('regen.bg.start');

    try {
        const refined = await refineBackgroundPrompt(originalBackgroundPrompt, changePrompt);
        const refinePromptMs = Date.now() - started;
        log.info({ ms: refinePromptMs }, 'regen.bg.prompt_merged');

        const bgStart = Date.now();
        const bgResult = await processImageBackground(
            req.file.buffer,
            req.file.originalname,
            refined.backgroundPrompt,
            abortController.signal,
            seedOption
        );
        log.info(
            {
                ms: Date.now() - bgStart,
                totalMs: Date.now() - started,
                seed: bgResult.seed,
            },
            'regen.bg.done'
        );

        res.status(200).json({
            success: true,
            generatedImageBase64: bgResult.imageBase64,
            backgroundPrompt: refined.backgroundPrompt,
            bgSeed: bgResult.seed,
            balance
        });
    } catch (error) {
        abortController.abort();
        await refundCredit(req.user.id); // didn't deliver — don't charge
        log.error({ err: error, ms: Date.now() - started }, `regen.bg.failed: ${error.message}`);
        res.status(502).json({ success: false, error: 'Background regeneration failed. Please try again.' });
    }
});

app.get('/api/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found.' });
    }
    res.status(200).json(job);
});

// Current credit balance for the signed-in user. Read-only (no consume) — drives
// the header pill and lets the UI gate actions before the user spends a request.
app.get('/api/me/balance', requireToken, async (req, res) => {
    try {
        const balance = await getBalance(req.user.id);
        res.status(200).json({ success: true, balance });
    } catch {
        res.status(503).json({ success: false, error: 'Service temporarily unavailable.' });
    }
});

async function processJob(jobId, file, body, userId) {
    const abortController = new AbortController();
    const jobLog = logger.child({ jobId, dish: body.dishName });
    const started = Date.now();

    jobLog.info({ shouldGenerateBg: body.generateBackground === 'true' }, 'job.start');

    try {
        const imageBuffer = file.buffer;
        const mimeType = file.mimetype;
        const originalName = file.originalname;
        const shouldGenerateBg = body.generateBackground === 'true';

        const copyStart = Date.now();
        const copyResult = await generateMarketingCopy(imageBuffer, mimeType, body);
        jobLog.info({ provider: copyResult.provider, ms: Date.now() - copyStart }, 'job.copy_done');

        let generatedImageBase64 = null;
        let bgSeed = null;
        if (shouldGenerateBg) {
            const bgStart = Date.now();
            // Background is text-only: the LLM-authored backgroundPrompt is the
            // sole signal. Both Standard (vibe → prompt) and Pro (free-form
            // description → prompt) flow through the same path.
            const bgResult = await processImageBackground(
                imageBuffer,
                originalName,
                copyResult.backgroundPrompt,
                abortController.signal
            );
            generatedImageBase64 = bgResult.imageBase64;
            bgSeed = bgResult.seed;
            jobLog.info(
                {
                    ms: Date.now() - bgStart,
                    seed: bgSeed,
                },
                'job.bg_done'
            );
        }

        jobs.set(jobId, {
            status: 'completed',
            data: {
                title: copyResult.title,
                description: copyResult.description,
                // Phase: per-platform captions. Array of { platform, body, noteTitle? }
                // ordered by the vendor's platform selection.
                captions: copyResult.captions,
                backgroundPrompt: copyResult.backgroundPrompt,
                generatedImageBase64: generatedImageBase64,
                bgSeed
            },
            error: null
        });

        jobLog.info({ totalMs: Date.now() - started }, 'job.complete');

    } catch (error) {
        abortController.abort();

        let errorMessage = "Internal server error";
        if (error instanceof SyntaxError) {
            errorMessage = "AI generation failed: Unable to parse JSON response.";
        } else if (error.code === 'ECONNABORTED' || error.response?.status === 504 || error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
            errorMessage = "A backend service timed out or was aborted.";
        } else {
            errorMessage = error.response?.data?.message || error.message || errorMessage;
        }

        jobLog.error({ err: error, totalMs: Date.now() - started }, `job.failed: ${errorMessage}`);
        // The credit was consumed at request time; the job failed, so refund it.
        await refundCredit(userId);
        jobs.set(jobId, { status: 'failed', data: null, error: errorMessage });
    }

    setTimeout(() => { jobs.delete(jobId); }, JOB_TTL_MS);
}

// Terminal JSON error handler. Multer (bad mimetype / too large) and CORS
// rejections would otherwise surface as Express's default HTML error page with
// a 500 — and that page carries no CORS headers, so the browser shows an opaque
// "Failed to fetch". Map the known cases to clean JSON; mask everything else.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
            ? 'Image is too large (max 5MB).'
            : err.code === 'LIMIT_UNEXPECTED_FILE'
                ? 'Unsupported file type. Please upload an image.'
                : 'Upload rejected.';
        return res.status(400).json({ success: false, error: msg });
    }
    if (err?.message?.includes('not allowed by CORS')) {
        return res.status(403).json({ success: false, error: 'Origin not allowed.' });
    }
    logger.error({ err }, 'unhandled.error');
    res.status(500).json({ success: false, error: 'Internal server error.' });
});

app.listen(port, () => {
    logger.info({ port }, 'SnapIT backend listening');
});