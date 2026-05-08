import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import { generateMarketingCopy, processImageBackground } from './services.js';

const app = express();
const port = process.env.PORT || 3000;

const corsOptions = {
    origin: process.env.FRONTEND_URL || '*', // Update this to your Netlify URL in production
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
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
    const { dishName, price, outputLanguage, backgroundVibe } = req.body;
    const shouldGenerateBg = generateBackground === "true";
    const requiredFields = shouldGenerateBg ? [dishName, price, outputLanguage, backgroundVibe] : [dishName, price, outputLanguage];


    if (requiredFields.some(field => typeof field !== 'string' || field.trim() === '')) {
        return res.status(400).json({
            success: false,
            error: `Missing required fields. Received: dishName(${dishName}), price(${price}), lang(${outputLanguage}), vibe(${backgroundVibe})`
        });
    }

    // 2. Job Creation phase
    const jobId = crypto.randomUUID();
    jobs.set(jobId, { status: 'processing', data: null, error: null });

    // 3. Immediate Response
    res.status(202).json({ success: true, jobId, message: 'Job accepted. Begin polling.' });

    // 4. Asynchronous Processing (Do not await)
    processJob(jobId, req.file, req.body);
});

app.get('/api/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found.' });
    }
    res.status(200).json(job);
});

// The background worker
async function processJob(jobId, file, body) {
    const abortController = new AbortController();

    try {
        const imageBuffer = file.buffer;
        const mimeType = file.mimetype;
        const originalName = file.originalname;
        const shouldGenerateBg = body.generateBackground === 'true';

        // Call your Gemini marketing copy service[cite: 1]
        const copyResult = await generateMarketingCopy(
            imageBuffer,
            mimeType,
            body
        );

        let generatedImageBase64 = null;
        if (shouldGenerateBg) {
            generatedImageBase64 = await processImageBackground(
                imageBuffer,
                originalName,
                copyResult.backgroundPrompt,
                abortController.signal
            );
        };

        // Save the successful payload identical to your old response structure[cite: 1]
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

    } catch (error) {
        abortController.abort();
        console.error(`[Job ${jobId}] Error:`, error);

        let errorMessage = "Internal server error";

        if (error instanceof SyntaxError) {
            errorMessage = "AI generation failed: Unable to parse JSON response.";
        } else if (error.code === 'ECONNABORTED' || error.response?.status === 504 || error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
            errorMessage = "A backend service timed out or was aborted.";
        } else {
            errorMessage = error.response?.data?.message || error.message || errorMessage;
        }

        jobs.set(jobId, { status: 'failed', data: null, error: errorMessage });
    }

    // Inside processJob, after completion or failure:
    setTimeout(() => {
        jobs.delete(jobId);
    }, 600000); // 10 minutes
}

app.listen(port, () => {
    console.log(`SnapIT backend listening on port ${port}`);
});