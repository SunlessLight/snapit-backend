import 'dotenv/config';

if (!process.env.OPENROUTER_API_KEY) {
    console.error('[boot] FATAL: OPENROUTER_API_KEY is not set. Did you start the server from snapit-backend/?');
    process.exit(1);
}

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import pinoHttp from 'pino-http';
import { generateMarketingCopy, processImageBackground, enhanceImageWithClaid } from './services.js';
import requireToken from './middleware/requireToken.js';
import logger from './logger.js';

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
        if (shouldGenerateBg) {
            const bgStart = Date.now();
            generatedImageBase64 = await processImageBackground(
                imageBuffer,
                originalName,
                copyResult.backgroundPrompt,
                abortController.signal
            );
            jobLog.info({ ms: Date.now() - bgStart }, 'job.bg_done');
        }

        jobs.set(jobId, {
            status: 'completed',
            data: {
                title: copyResult.title,
                description: copyResult.description,
                caption: copyResult.caption,
                backgroundPrompt: copyResult.backgroundPrompt,
                generatedImageBase64: generatedImageBase64
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