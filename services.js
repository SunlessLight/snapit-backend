import axios from 'axios';
import FormData from 'form-data';
import { generateWithCascade } from './llmCascade.js';

// Concrete linguistic-marker rules per tone preset. Abstract adjectives ("professional",
// "cozy") produced near-identical output in v1 — these spell out sentence length, emoji
// density, Manglish frequency, and voice so the model actually differentiates.
const TONE_RULES = {
    casual: `CASUAL & FRIENDLY — write like a warm Malaysian stall owner chatting with a regular. Sentence length 8-15 words. Light Manglish welcome ("lah", "memang", "boleh") but sparingly — do not append "lah" to every sentence. 2-3 warm emojis spread across the caption (❤️ 🤤 ☕ 🍲 📍 style). Use contractions naturally ("we're", "it's", "that's"). First-person ("we", "our"). Include one opinionated noticing-something detail that sounds like a real human, not a template.`,
    punchy: `SHORT & PUNCHY — terse, scannable, zero fluff. Sentence length 3-8 words. Fragments are encouraged — most "sentences" shouldn't be full sentences. Price and location upfront. 0-1 emoji TOTAL across the caption. Imperative voice ("Come try", "Don't sleep on this", "Open daily 7am"). No backstory, no warmth-padding — just the facts a hungry person needs to decide.`,
    polished: `POLISHED & MODERN — modern-cafe social media voice. Sentence length 12-18 words, complete grammar, no fragments. Open with one specific sensory or sourcing detail ("hand-roasted this morning", "ikan bilis from the wet market"). Minimal Manglish — at most one cultural nod per caption, not per sentence. 1-2 strategic emojis (not decorative). Sound informed without being preachy or corporate.`,
    playful: `PLAYFUL & CHEEKY — light puns, self-aware jokes, casual English. Sentence length 5-12 words. Land at least one piece of wordplay or a small joke per caption — don't over-explain it. 3-4 emojis welcome, including playful ones (😏 🫶 🤌 👀 alongside food/heart). Warm self-roast tone, never mean. Confidence with a wink.`,
};

// Length presets — word counts exclude hashtags. The model treats these as hard targets.
const LENGTH_RULES = {
    short: `SHORT — aim for 20-50 words TOTAL in the caption body (hashtags excluded). One hook + one dish/value sentence + one CTA. No backstory. This is the default because most food posts work best at this length.`,
    medium: `MEDIUM — aim for 50-80 words TOTAL in the caption body (hashtags excluded). One hook + one or two sentences of relevant context (a sourcing detail, a tiny story, a regular's reaction) + CTA + location/hours if it fits naturally.`,
    long: `LONG — aim for 80-120 words TOTAL in the caption body (hashtags excluded). One hook + two or three sentences of meaningful context (origin, sourcing, the why behind the dish) + CTA + location/hours. Only use this length when there is a real story worth telling — do not pad.`,
};

// Per-language style rules. Lifted out of the prompt menu so we inject only the
// selected language — small models (Gemma MoE) read a multi-option list as a
// checklist and produce all variants stacked into the open-ended caption field.
const LANGUAGE_RULES = {
    'English': `Casual everyday Malaysian English. Punchy, realistic, contractions throughout. Avoid formal/textbook phrasing.`,
    'Bahasa Melayu': `Casual conversational Malay as a friendly stall owner would speak. Warm, direct, no formal civil-service register. Keep "RM" for price.`,
    '中文': `Casual Simplified Chinese as a friendly Malaysian Chinese vendor. Direct, hawker-stall energy. Keep "RM" for price. Avoid Mainland-China-specific idioms; lean Malaysian-Chinese phrasing.`,
    'Local Style': `Heavy Malaysian street slang / Manglish (e.g. 'Ngam ngam', 'Padu', 'Fuh', 'Memang layan', 'Syiok gila', 'Don't play play'). The TONE rules still apply on top — e.g. a punchy Local Style caption is still terse fragments, just in Manglish.`,
};

const TONE_KEYS = new Set(Object.keys(TONE_RULES));
const LENGTH_KEYS = new Set(Object.keys(LENGTH_RULES));
const LANGUAGE_KEYS = new Set(Object.keys(LANGUAGE_RULES));

export async function generateMarketingCopy(imageBuffer, mimeType, params) {
    const {
        dishName, price, outputLanguage, backgroundVibe, generateBackground,
        isContextPro, description, tone, captionLength, backgroundDescription
    } = params;
    const shouldGenerateBg = generateBackground === 'true';
    const isPro = isContextPro === 'true';
    const hasProBgDescription = isPro && shouldGenerateBg
        && typeof backgroundDescription === 'string'
        && backgroundDescription.trim() !== '';

    // Defensive: server.js validates these, but if a stray request slips through with
    // missing/invalid values we fall back to the Standard-mode defaults rather than 500.
    const toneKey = TONE_KEYS.has(tone) ? tone : 'casual';
    const lengthKey = LENGTH_KEYS.has(captionLength) ? captionLength : 'short';
    // `Chinese` alias kept so any client still sending the old value still resolves
    // to the 中文 rule (matches the CRITICAL LANGUAGE RULES branch that already
    // handled both spellings). Unknown values fall back to English.
    const languageKey = LANGUAGE_KEYS.has(outputLanguage)
        ? outputLanguage
        : (outputLanguage === 'Chinese' ? '中文' : 'English');

    const proBlock = isPro && typeof description === 'string' && description.trim() !== '' ? `
        PRO CONTEXT — VENDOR-PROVIDED:
        Vendor's Own Description: "${description}"

        Weave any factual ingredient/origin/process details from the vendor's description into the description and caption naturally — do not quote it verbatim and do not invent details the vendor did not state. The TONE and LENGTH rules above still govern voice and word count.
    ` : '';

    let backgroundVibeString = "";

    if (shouldGenerateBg) {
        if (hasProBgDescription) {
            // Pro vendors describe the background themselves; the pill switch is
            // ignored in this branch. Gemini polishes this verbatim into a final
            // backgroundPrompt (see TASK 2 below).
            backgroundVibeString = backgroundDescription.trim();
        } else {
            switch (backgroundVibe) {
                case 'kopitiam':
                    backgroundVibeString = "Classic Malaysian Kopitiam. White marble table surface with slight imperfections. Harsh, bright fluorescent overhead lighting. Authentic, traditional local feel.";
                    break;
                case 'cafe':
                    backgroundVibeString = "Modern, bright aesthetic cafe. Light oak wood table surface. Soft, warm natural sunlight streaming from a window. Clean, inviting, and highly appetizing.";
                    break;
                case 'street':
                    backgroundVibeString = "Night market or street food vibe. Dark, textured asphalt or stainless steel cart surface. Warm, glowing bokeh from neon signs or street lamps in the background. High contrast, energetic.";
                    break;
                case 'premium':
                    backgroundVibeString = "High-end modern restaurant. Smooth, dark walnut wood or clean slate surface. Soft, elegant, diffused studio lighting. Minimalist, uncluttered, and highly professional.";
                    break;
            }
        }
    }

    const prompt = `
        You are an expert Malaysian social media copywriter for food vendors and a food-photography prompt engineer. Analyze the uploaded food product image.

        Context:
        Dish Name: ${dishName}
        Price: ${price}
        Output Language: ${languageKey}
        Background Vibe: ${backgroundVibeString}
        ${proBlock}
        --- TASK 1: COPYWRITING (Title, Description, Caption) ---

        UNIVERSAL RULES (apply to title, description, and caption):
        1. CURRENCY: Always use "RM" (e.g., RM 13.50). Never use "$".
        2. CONTRACTIONS: Use them naturally ("we're", "it's", "that's"). Spelled-out forms ("we are", "it is") read as AI-generated.
        3. NO ADJECTIVE STACKING: Do NOT write strings like "fresh, vibrant, delicious, aromatic". One adjective per noun, max.
        4. VARY SENTENCE OPENINGS: Do not start consecutive sentences with the same word or structure.
        5. NO GENERIC ENGAGEMENT FILLER: Do not write "Let us know in the comments!", "What are your thoughts?", "Drop a 🔥 below", or similar canned prompts.
        6. BANNED WORDS — never use any of: "Indulge", "Exquisite", "Harmonious", "Whimsical", "Delightful", "Elevate", "Symphony", "Serene", "Savour", "Aromatic", "Companion", "Experience", "Viral", "Journey", "Realm", "Transformative", "Masterpiece", "Adventure", "Culinary", "Palate", "Flavor adventure", "Elevate your palate", "Culinary masterpiece".

        TONE — this is non-negotiable for the caption:
        ${TONE_RULES[toneKey]}

        LENGTH — this is non-negotiable for the caption body:
        ${LENGTH_RULES[lengthKey]}

        HASHTAG STRATEGY (always append to caption):
        Append 5-7 hashtags at the very end of the caption, on a new line after a blank line. Mix roughly:
        - ~40% local/micro-local: city or neighbourhood + food (#klfood, #pjeats, #penangfood, #subangeats, #bangsareats)
        - ~30% category-specific: the actual dish or cuisine (#nasilemak, #charkwayteow, #mamak, #kopitiam, #tehtarik)
        - ~20% broad discovery: #malaysianfood, #foodmalaysia, #malaysiafoodie
        - ~10% brand/niche: #homemade, #halal, #traditional, #streetfood (pick what actually fits the dish)
        Do not use more than 7 hashtags. Do not pad with generic #foodie #yum #instafood — Instagram 2025 ranks relevance over volume.

        OUTPUT LANGUAGE — write the title, description, AND caption in this ONE language style only. Do NOT produce multiple language variants. Do NOT include the words "title:", "description:", or "caption:" inside any field's text — those are field names, not content.

        ${LANGUAGE_RULES[languageKey]}

        The title and description follow the same language but stay slightly more readable than the caption.

        Provide the text for these specific fields:
        - title: A short, punchy, realistic name for the dish (max 3-5 words). Keep it simple ("Crispy Fish Noodle Soup", NOT "Exquisite Fish Noodle Symphony"). Title is exempt from the TONE/LENGTH rules.
        - description: A 1-2 sentence factual menu description. Taste, texture, ingredients. No emotional fluff. Exempt from TONE/LENGTH rules but still bound by UNIVERSAL RULES.
        - caption: A scroll-stopping Instagram caption written under the TONE and LENGTH rules above, followed by the hashtag block per HASHTAG STRATEGY. Mention the price somewhere natural — do not force it into a fixed line position.

        ${shouldGenerateBg ? `
        --- TASK 2: BACKGROUND GENERATION PROMPT ---
        Determine the camera perspective of the uploaded food image:
        - Is it a Top-Down (flatlay) shot pointing straight down?
        - Or is it an Angled/Profile shot showing depth?

        Write the 'backgroundPrompt' based on the perspective and the Background Vibe ("${backgroundVibeString}").
        ${hasProBgDescription ? `
        IMPORTANT — VENDOR-PROVIDED BACKGROUND:
        The Background Vibe above came verbatim from the vendor. Use it as the primary creative direction. Polish it into a professional food-photography prompt by adding lighting, surface texture, and depth-of-field details that stay faithful to their intent. Do not invent contradictory elements (e.g., do not change "marble" to "wood"). If the vendor's text is sparse, expand with food-photography fundamentals; if it is detailed, preserve its specifics.
        ` : ''}
        CRITICAL RULES FOR BACKGROUND PROMPT:
        1. DO NOT describe the food itself. The food is already cut out.
        2. IF TOP-DOWN: Describe ONLY a flat surface texture directly beneath the food. Do NOT mention a background, room, or depth of field.
        3. IF ANGLED: Describe the surface beneath the food AND a softly blurred environment behind it to create depth.
        ` : `
        --- TASK 2: BACKGROUND GENERATION PROMPT ---
        Ignore this task. Just return "N/A" for the backgroundPrompt field.
        `}
    `;

    const schema = {
        type: "object",
        properties: {
            title: { type: "string" },
            description: { type: "string" },
            caption: { type: "string" },
            backgroundPrompt: { type: "string" }
        },
        required: ["title", "description", "caption", "backgroundPrompt"],
        additionalProperties: false
    };

    return await generateWithCascade(prompt, schema, imageBuffer.toString("base64"), mimeType);
};

// Food-tuned Claid operations. Values are conservative-but-noticeable defaults — meant
// to be tuned during Phase 6 verification on real low-light kopitiam, bright cafe, and
// messy-plate shots. Decompress fixes JPEG block artefacts; HDR pulls shadow detail
// out; sharpening + saturation are small bumps so we don't over-AI the result.
const CLAID_FOOD_OPERATIONS = {
    restorations: {
        decompress: 'auto',
    },
    adjustments: {
        hdr: { intensity: 60 },
        sharpness: 25,
        saturation: 15,
    },
};

export async function enhanceImageWithClaid(imageBuffer, mimeType, abortSignal) {
    if (!process.env.CLAID_API_KEY) {
        throw new Error('CLAID_API_KEY is not set');
    }

    const formData = new FormData();
    formData.append('file', imageBuffer, { filename: `upload.${mimeType.split('/')[1] || 'jpg'}`, contentType: mimeType });
    formData.append('data', JSON.stringify({ operations: CLAID_FOOD_OPERATIONS }));

    // Step 1: upload + process. /v1/image/edit/upload returns JSON with a tmp_url —
    // NOT the binary. The /v1-ext/... path does not exist (returns 404).
    const uploadResponse = await axios.post('https://api.claid.ai/v1/image/edit/upload', formData, {
        headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${process.env.CLAID_API_KEY}`,
        },
        timeout: 15000,
        signal: abortSignal,
    });

    const tmpUrl = uploadResponse?.data?.data?.output?.tmp_url;
    if (!tmpUrl) {
        throw new Error('Claid response missing data.output.tmp_url');
    }

    // Step 2: fetch the processed image binary from the temporal URL. No auth header
    // here — tmp_url is pre-signed.
    const imageResponse = await axios.get(tmpUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        signal: abortSignal,
    });

    return Buffer.from(imageResponse.data, 'binary');
}

export async function processImageBackground(imageBuffer, originalName, backgroundPrompt, abortSignal) {
    const formData = new FormData();
    formData.append('imageFile', imageBuffer, { filename: originalName || 'upload.png' }); //[cite: 2]
    formData.append('background.prompt', backgroundPrompt); //[cite: 2]
    formData.append('referenceBox', 'originalImage'); //[cite: 2]
    formData.append('background.expandPrompt.mode', 'ai.never'); //[cite: 2]

    const response = await axios.post(process.env.IMAGE_PROCESSING_API_URL, formData, {
        headers: {
            'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`, //[cite: 2]
            'x-api-key': `${process.env.IMAGE_PROCESSING_API_KEY}`, //[cite: 2]
            'pr-ai-background-model-version': `background-studio-beta-2025-03-17`, //[cite: 2]
        },
        responseType: 'arraybuffer', //[cite: 2]
        timeout: 15000, //[cite: 2]
        signal: abortSignal //[cite: 2]
    });

    return Buffer.from(response.data, 'binary').toString('base64'); //[cite: 2]
}