import 'dotenv/config';

if (!process.env.OPENROUTER_API_KEY) {
    console.error('[boot] FATAL: OPENROUTER_API_KEY is not set. Did you start the server from snapit-backend/?');
    process.exit(1);
}

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pinoHttp from 'pino-http';
import { generateMarketingCopy, processImageBackground, enhanceImageWithClaid, refineMarketingCopy, refineBackgroundPrompt, previewSegmentation } from './services.js';
import requireToken from './middleware/requireToken.js';
import logger from './logger.js';

// Phase 6.7.3 — scene reference cache. Loaded once on boot, kept in memory.
// Same pattern Phase 7A's watermark will use. Missing files are not an error;
// the cache simply omits that vibe and processJob falls through to text-only
// background generation. See snapit-backend/assets/scenes/README.md for the
// Owner-action checklist of what files need to land here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENE_VIBES = ['kopitiam', 'cafe', 'street', 'premium'];
const SCENE_CACHE = new Map();
for (const vibe of SCENE_VIBES) {
    const filePath = path.join(__dirname, 'assets', 'scenes', `${vibe}.jpg`);
    try {
        const buf = fs.readFileSync(filePath);
        SCENE_CACHE.set(vibe, { buffer: buf, filename: `${vibe}.jpg` });
    } catch {
        // File missing — text-only fallback. No log noise until first use.
    }
}
logger.info(
    { loaded: [...SCENE_CACHE.keys()], expected: SCENE_VIBES },
    'scene_cache.boot'
);

const app = express();
const port = process.env.PORT || 3000;

const corsOptions = {
    origin: process.env.FRONTEND_URL || '*',
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
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

const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

const jobs = new Map();

app.post('/api/generate', upload.single('image'), (req, res) => {
    // 1. Validation phase
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }

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

    // 2. Job Creation phase
    const jobId = crypto.randomUUID();
    jobs.set(jobId, { status: 'processing', data: null, error: null });

    // 3. Immediate Response
    res.status(202).json({ success: true, jobId, message: 'Job accepted. Begin polling.' });

    // 4. Asynchronous Processing (Do not await)
    processJob(jobId, req.file, req.body);
});

app.post('/api/enhance', requireToken, upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }

    const abortController = new AbortController();
    const started = Date.now();
    const enhanceLog = logger.child({ route: 'enhance', size: req.file.size, mime: req.file.mimetype });
    enhanceLog.info('enhance.start');

    try {
        const enhancedBuffer = await enhanceImageWithClaid(req.file.buffer, req.file.mimetype, abortController.signal);
        enhanceLog.info({ ms: Date.now() - started, outBytes: enhancedBuffer.length }, 'enhance.done');
        res.set('Content-Type', 'image/jpeg').send(enhancedBuffer);
    } catch (error) {
        abortController.abort();
        const errorMessage = error.response?.data?.toString?.() || error.message || 'Enhance failed';
        enhanceLog.error({ err: error, ms: Date.now() - started }, `enhance.failed: ${errorMessage}`);
        res.status(502).json({ success: false, error: errorMessage });
    }
});

// Assistive-mode caption regen. Sync — user is sitting on the Review screen.
// Re-sends image instead of relying on the jobs Map so the loop's lifetime is
// not coupled to the 10-min TTL.
app.post('/api/regenerate/captions', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }
    const {
        dishName, price, outputLanguage, tone, captionLength,
        isContextPro, description,
        currentTitle, currentDescription, currentCaption, changePrompt
    } = req.body;

    if (!dishName || !price || !outputLanguage) {
        return res.status(400).json({ success: false, error: 'dishName, price, outputLanguage are required.' });
    }

    const started = Date.now();
    const log = logger.child({ route: 'regenerate.captions', dish: dishName });
    log.info('regen.captions.start');

    try {
        const result = await refineMarketingCopy(
            req.file.buffer,
            req.file.mimetype,
            { dishName, price, outputLanguage, isContextPro, description, tone, captionLength },
            { title: currentTitle, description: currentDescription, caption: currentCaption },
            changePrompt
        );
        log.info({ ms: Date.now() - started, provider: result.provider }, 'regen.captions.done');
        res.status(200).json({
            success: true,
            title: result.title,
            description: result.description,
            caption: result.caption
        });
    } catch (error) {
        log.error({ err: error, ms: Date.now() - started }, `regen.captions.failed: ${error.message}`);
        res.status(502).json({ success: false, error: error.message || 'Caption regen failed' });
    }
});

// Assistive-mode background regen. Always runs on the ORIGINAL food image
// (frontend sends mediaState.originalFile, not the previously bg-swapped output)
// so artifacts don't compound across iterations.
app.post('/api/regenerate/background', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }
    const { originalBackgroundPrompt, changePrompt, seedMode, lastSeed } = req.body;
    if (!originalBackgroundPrompt) {
        return res.status(400).json({ success: false, error: 'originalBackgroundPrompt is required.' });
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
                uncertaintyScore: bgResult.uncertaintyScore,
                seed: bgResult.seed,
            },
            'regen.bg.done'
        );

        res.status(200).json({
            success: true,
            generatedImageBase64: bgResult.imageBase64,
            backgroundPrompt: refined.backgroundPrompt,
            bgUncertaintyScore: bgResult.uncertaintyScore,
            bgSeed: bgResult.seed
        });
    } catch (error) {
        abortController.abort();
        log.error({ err: error, ms: Date.now() - started }, `regen.bg.failed: ${error.message}`);
        res.status(502).json({ success: false, error: error.message || 'Background regen failed' });
    }
});

// Phase 6.7.5 — pre-generation mask preview. Sync (~2-4s) — user is waiting
// on the MaskPreview screen. Returns a PNG cutout (subject on transparent
// background) so the user can decide "looks right" → continue to /api/generate,
// or "retake" → back to Upload without spending a /v2/edit credit.
app.post('/api/segmentation-preview', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required.' });
    }

    const abortController = new AbortController();
    const started = Date.now();
    const log = logger.child({ route: 'segmentation-preview', size: req.file.size, mime: req.file.mimetype });
    log.info('segment.start');

    try {
        const cutoutBuffer = await previewSegmentation(req.file.buffer, req.file.originalname, abortController.signal);
        log.info({ ms: Date.now() - started, outBytes: cutoutBuffer.length }, 'segment.done');
        res.set('Content-Type', 'image/png').send(cutoutBuffer);
    } catch (error) {
        abortController.abort();
        const errorMessage = error.response?.data?.toString?.() || error.message || 'Segment failed';
        log.error({ err: error, ms: Date.now() - started }, `segment.failed: ${errorMessage}`);
        res.status(502).json({ success: false, error: errorMessage });
    }
});

app.get('/api/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found.' });
    }
    res.status(200).json(job);
});

async function processJob(jobId, file, body) {
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
        let bgUncertaintyScore = null;
        let bgSeed = null;
        if (shouldGenerateBg) {
            const bgStart = Date.now();
            // Standard mode: send a style-reference image if we have one
            // cached for the selected vibe. Pro mode stays text-only (the
            // vendor's free-form description is the signal there). Missing
            // cache entries are silent fallback — see SCENE_CACHE init.
            const isPro = body.isContextPro === 'true';
            const sceneAsset = !isPro && body.backgroundVibe
                ? SCENE_CACHE.get(body.backgroundVibe)
                : null;
            const bgResult = await processImageBackground(
                imageBuffer,
                originalName,
                copyResult.backgroundPrompt,
                abortController.signal,
                sceneAsset
                    ? { guidanceImageBuffer: sceneAsset.buffer, guidanceFilename: sceneAsset.filename }
                    : undefined
            );
            generatedImageBase64 = bgResult.imageBase64;
            bgUncertaintyScore = bgResult.uncertaintyScore;
            bgSeed = bgResult.seed;
            jobLog.info(
                {
                    ms: Date.now() - bgStart,
                    uncertaintyScore: bgUncertaintyScore,
                    seed: bgSeed,
                    guidance: sceneAsset ? body.backgroundVibe : null,
                },
                'job.bg_done'
            );
        }

        jobs.set(jobId, {
            status: 'completed',
            data: {
                title: copyResult.title,
                description: copyResult.description,
                caption: copyResult.caption,
                backgroundPrompt: copyResult.backgroundPrompt,
                generatedImageBase64: generatedImageBase64,
                bgUncertaintyScore,
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
        jobs.set(jobId, { status: 'failed', data: null, error: errorMessage });
    }

    setTimeout(() => { jobs.delete(jobId); }, 600000);
}

app.listen(port, () => {
    logger.info({ port }, 'SnapIT backend listening');
});