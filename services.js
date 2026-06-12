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

// Per-platform structure rules. Same philosophy as TONE_RULES: concrete,
// marker-based instructions (where the hook sits, how many hashtags, emoji
// density, what the CTA points at) so the model produces output that reads as
// native to each platform instead of one generic "social caption". Hashtag
// policy lives INSIDE each block — it's platform-specific, not universal.
// Delivery is deliberately not a caption: it overrides TONE/LENGTH and omits
// hashtags/emoji/CTA/business-info entirely (the delivery app shows those).
const PLATFORM_RULES = {
    instagram: `INSTAGRAM — write for the feed. The FIRST line is a standalone hook that must work before the "...more" fold (Instagram hides everything after ~1-2 lines) — do NOT put an emoji in that first line. Follow with 1-2 lines of value, then exactly ONE specific call-to-action ("Come try it this weekend", "Save this for your next makan trip") — never stack multiple asks. 2-3 emojis in the body only. End with a blank line, then 5-7 hashtags mixing ~40% local/micro-local (use the vendor's location when given, e.g. #bangsareats #klfood), ~30% the actual dish/cuisine (#nasilemak #charkueyteow), ~20% broad (#malaysianfood #foodmalaysia), ~10% niche (#halal #homemade). No #foodie #yum #instafood filler.`,
    facebook: `FACEBOOK — write like a post in a local makan group, not an ad. Warm, conversational, community voice; Bahasa Rojak welcome. Slightly longer and chattier than Instagram is fine. The call-to-action points to a real next step the vendor can act on — WhatsApp/message to order, call, or drop by (use the vendor's contact and hours when given). Use 0-2 hashtags at most, or none — Facebook is not a hashtag-discovery platform and heavy tags read as spam here. Light emoji only.`,
    xiaohongshu: `XIAOHONGSHU (小红书/RED) — write a 种草 ("grass-planting") recommendation note, not an ad. Produce TWO parts: (1) a short scroll-stopping NOTE TITLE (≤20 characters, 1-2 emojis) for the xiaohongshu_title field — curiosity or a bold tasty claim, e.g. "🤤这家叻沙汤头绝了"; (2) the BODY: short lines separated by line breaks, each key line starting with an emoji (✨ 📍 💰 🍜 style), sprinkled with searchable keywords a hungry user would type (dish name, area, 平价, 必点). Keep it diary-like and personal, not corporate. End with 3-5 RED-style #tags (dish + area + vibe). Heavier emoji use than Instagram is expected and on-brand here.`,
    delivery: `DELIVERY MENU (GrabFood / Foodpanda) — this is NOT a social caption. Write a single appetising menu-item description of 1-2 factual sentences: what's in it, the key textures/tastes, what makes it worth ordering. NO hashtags. NO emoji. NO call-to-action and NO location/hours/contact (the delivery app already shows those). Ignore the TONE and LENGTH presets — menu copy is its own register. Descriptive but honest, e.g. "Crispy fried chicken thigh over fragrant coconut rice, with house sambal and a runny-yolk egg."`,
};

// Maps each platform to its output field. Xiaohongshu carries a second field
// (the note title) because RED notes have a distinct clickable title separate
// from the body.
const PLATFORM_FIELD = {
    instagram: { field: 'caption_instagram', label: 'Instagram caption' },
    facebook: { field: 'caption_facebook', label: 'Facebook post' },
    xiaohongshu: { field: 'caption_xiaohongshu', label: 'Xiaohongshu note body' },
    delivery: { field: 'caption_delivery', label: 'Delivery menu description' },
};

const TONE_KEYS = new Set(Object.keys(TONE_RULES));
const LENGTH_KEYS = new Set(Object.keys(LENGTH_RULES));
const LANGUAGE_KEYS = new Set(Object.keys(LANGUAGE_RULES));
const PLATFORM_KEYS = new Set(Object.keys(PLATFORM_RULES));

// Parse the multipart `platforms` field (CSV or array) into a validated,
// de-duped, order-preserving list. Falls back to ['instagram'] so a missing or
// all-invalid value never produces an empty caption set.
function parsePlatforms(raw) {
    const list = Array.isArray(raw)
        ? raw
        : (typeof raw === 'string' ? raw.split(',') : []);
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const key = String(item).trim();
        if (PLATFORM_KEYS.has(key) && !seen.has(key)) {
            seen.add(key);
            out.push(key);
        }
    }
    return out.length ? out : ['instagram'];
}

// Build the optional STALL INFO prompt block from vendor business fields.
// Empty fields are simply absent (no "Location: " artifacts). The delivery
// field is told to ignore this — see PLATFORM_RULES.delivery.
function buildStallBlock({ location, hours, contact }) {
    const parts = [];
    if (typeof location === 'string' && location.trim()) parts.push(`Location: ${location.trim()}`);
    if (typeof hours === 'string' && hours.trim()) parts.push(`Operating hours: ${hours.trim()}`);
    if (typeof contact === 'string' && contact.trim()) parts.push(`Contact: ${contact.trim()}`);
    if (!parts.length) return '';
    return `
        STALL INFO — VENDOR-PROVIDED:
        ${parts.join('\n        ')}

        Weave these naturally into the social captions where they help the reader act (Instagram's CTA, Facebook's "WhatsApp to order / drop by"). Do NOT invent any of these details, and do NOT include them in the delivery menu field.
    `;
}

export async function generateMarketingCopy(imageBuffer, mimeType, params) {
    const {
        dishName, price, outputLanguage, backgroundVibe, generateBackground,
        isContextPro, description, tone, captionLength, backgroundDescription,
        platforms, location, hours, contact
    } = params;
    const selectedPlatforms = parsePlatforms(platforms);
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

    const stallBlock = buildStallBlock({ location, hours, contact });

    // One labelled rule block per selected platform, plus the per-platform
    // output-field instructions. Built dynamically so the prompt only carries
    // the platforms the vendor actually picked.
    const platformRulesSection = selectedPlatforms
        .map((p) => `- ${PLATFORM_RULES[p]}`)
        .join('\n\n        ');
    const platformFieldInstructions = selectedPlatforms
        .map((p) => {
            if (p === 'xiaohongshu') {
                return `- ${PLATFORM_FIELD[p].field}: the Xiaohongshu note BODY (line-broken, emoji-led) per the XIAOHONGSHU rule above.\n        - xiaohongshu_title: the short RED note title (≤20 chars, 1-2 emojis) per the XIAOHONGSHU rule above.`;
            }
            return `- ${PLATFORM_FIELD[p].field}: ${PLATFORM_FIELD[p].label} written under the ${p.toUpperCase()} rule above.`;
        })
        .join('\n        ');

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
        ${stallBlock}
        --- TASK 1: COPYWRITING (Title, Description, and one caption per platform) ---

        UNIVERSAL RULES (apply to title, description, and every caption):
        1. CURRENCY: Always use "RM" (e.g., RM 13.50). Never use "$".
        2. CONTRACTIONS: Use them naturally ("we're", "it's", "that's"). Spelled-out forms ("we are", "it is") read as AI-generated.
        3. NO ADJECTIVE STACKING: Do NOT write strings like "fresh, vibrant, delicious, aromatic". One adjective per noun, max.
        4. VARY SENTENCE OPENINGS: Do not start consecutive sentences with the same word or structure.
        5. NO GENERIC ENGAGEMENT FILLER: Do not write "Let us know in the comments!", "What are your thoughts?", "Drop a 🔥 below", or similar canned prompts.
        6. BANNED WORDS — never use any of: "Indulge", "Exquisite", "Harmonious", "Whimsical", "Delightful", "Elevate", "Symphony", "Serene", "Savour", "Aromatic", "Companion", "Experience", "Viral", "Journey", "Realm", "Transformative", "Masterpiece", "Adventure", "Culinary", "Palate", "Flavor adventure", "Elevate your palate", "Culinary masterpiece".

        TONE — governs the voice of every social caption (Instagram, Facebook, Xiaohongshu):
        ${TONE_RULES[toneKey]}

        LENGTH — a guide for Instagram and Facebook caption bodies. Each PLATFORM rule below takes precedence where it conflicts; Xiaohongshu and the Delivery menu set their own length and ignore this:
        ${LENGTH_RULES[lengthKey]}

        PLATFORM RULES — each selected platform has its own structure, hashtag policy, emoji density, and call-to-action. Write each platform's caption to ITS rule; do not blur the voices together or reuse the same text across platforms:
        ${platformRulesSection}

        OUTPUT LANGUAGE — write the title, description, AND every caption in this ONE language style only. Do NOT produce multiple language variants of a field. Do NOT include field names like "title:" or "caption:" inside any field's text.

        ${LANGUAGE_RULES[languageKey]}

        The title and description follow the same language but stay slightly more readable than the captions.

        Provide the text for these specific fields:
        - title: A short, punchy, realistic name for the dish (max 3-5 words). Keep it simple ("Crispy Fish Noodle Soup", NOT "Exquisite Fish Noodle Symphony"). Title is exempt from the TONE/LENGTH rules.
        - description: A 1-2 sentence factual menu description. Taste, texture, ingredients. No emotional fluff. Exempt from TONE/LENGTH rules but still bound by UNIVERSAL RULES.
        ${platformFieldInstructions}
        Mention the price somewhere natural in each social caption — do not force it into a fixed line position.

        ${shouldGenerateBg ? `
        --- TASK 2: BACKGROUND GENERATION PROMPT ---
        Look at the uploaded photo and decide what is visible AROUND the dish, then classify the camera perspective into ONE of these three regimes:
        - FLATLAY: shot pointing straight down. Only a flat surface is visible around the dish; no sense of depth.
        - TABLE-LEVEL ANGLE: shot looking down at the table at a tilt. The dish sits on a surface that extends and recedes in ALL directions; the area behind and above the dish is still the SAME eating surface (same material), not a separate standing space. No wall, no horizon. This is the most common phone-photo case.
        - PROFILE / LOW ANGLE: the camera is nearly level with the dish. There is a CLEAR break between the near surface (lower part of the frame) and a distinct standing space behind it (a wall, window, room, or open air).
        When unsure between TABLE-LEVEL and PROFILE, choose TABLE-LEVEL — inventing a wall that is not there is the worse mistake.

        Write the 'backgroundPrompt' from the chosen regime and the Background Vibe ("${backgroundVibeString}"). The Background Vibe supplies the MOOD, surface MATERIAL, and LIGHTING; the perspective regime decides the SPATIAL LAYOUT. So a "blurred background" mood cue becomes blur on the receding surface in a TABLE-LEVEL shot, not a separate wall.
        ${hasProBgDescription ? `
        IMPORTANT — VENDOR-PROVIDED BACKGROUND:
        The Background Vibe above came verbatim from the vendor. Use it as the primary creative direction. Polish it into a professional food-photography prompt by adding lighting, surface texture, and depth-of-field details that stay faithful to their intent. Do not invent contradictory elements (e.g., do not change "marble" to "wood"). If the vendor's text is sparse, expand with food-photography fundamentals; if it is detailed, preserve its specifics.
        ` : ''}
        CRITICAL RULES FOR BACKGROUND PROMPT:
        1. DO NOT describe the food itself. The food is already cut out.
        2. IF FLATLAY: Describe ONLY a flat surface texture filling the frame beneath the dish. Do NOT mention a background, room, horizon, or depth of field.
        3. IF TABLE-LEVEL ANGLE: Describe a surface that FILLS THE WHOLE FRAME and extends around the dish, gently receding and softly out of focus toward the top/far edge. Do NOT introduce a separate vertical background, wall, or horizon line — the surface itself is the entire scene, blurred with depth of field as it recedes.
        4. IF PROFILE / LOW ANGLE: Describe the surface beneath the dish in the foreground AND a softly blurred standing environment behind it to create depth.
        ` : `
        --- TASK 2: BACKGROUND GENERATION PROMPT ---
        Ignore this task. Just return "N/A" for the backgroundPrompt field.
        `}
    `;

    // Dynamic schema — one required caption field per selected platform (RED
    // adds its note-title field). Built per-request rather than fixed so the
    // model is only asked for the platforms the vendor picked. Strict per-field
    // schema (not an open-ended list) keeps small models from stacking variants.
    const properties = {
        title: { type: "string" },
        description: { type: "string" },
    };
    const required = ["title", "description"];
    for (const p of selectedPlatforms) {
        properties[PLATFORM_FIELD[p].field] = { type: "string" };
        required.push(PLATFORM_FIELD[p].field);
        if (p === 'xiaohongshu') {
            properties.xiaohongshu_title = { type: "string" };
            required.push('xiaohongshu_title');
        }
    }
    properties.backgroundPrompt = { type: "string" };
    required.push("backgroundPrompt");

    const schema = { type: "object", properties, required, additionalProperties: false };

    const result = await generateWithCascade(prompt, schema, imageBuffer.toString("base64"), mimeType);

    // Re-shape the flat LLM fields into an ordered captions array the frontend
    // can map over. Keeps the strict-schema flatness on the wire while giving
    // the UI a clean per-platform structure.
    const captions = selectedPlatforms.map((p) => {
        const entry = { platform: p, body: result[PLATFORM_FIELD[p].field] || '' };
        if (p === 'xiaohongshu') entry.noteTitle = result.xiaohongshu_title || '';
        return entry;
    });

    return {
        title: result.title,
        description: result.description,
        captions,
        backgroundPrompt: result.backgroundPrompt,
        provider: result.provider,
        // Measured OpenRouter cost/tokens (see llmCascade.js) for the usage log.
        usage: result.usage,
    };
};

// Assistive-mode caption refinement. Refines ONE platform's caption (the
// platform the vendor is regenerating on Review). Title/description are shared
// across platforms, so they're left untouched here — only the targeted
// caption (and, for Xiaohongshu, its note title) is returned. Tone/length/
// language/platform are reused from the original call so the refined draft
// stays coherent. backgroundPrompt is regenerated separately via
// refineBackgroundPrompt to keep the two assistive levers independent.
export async function refineMarketingCopy(imageBuffer, mimeType, params, currentDraft, changePrompt) {
    const {
        dishName, price, outputLanguage,
        isContextPro, description, tone, captionLength,
        platform, location, hours, contact
    } = params;
    const isPro = isContextPro === 'true';
    const toneKey = TONE_KEYS.has(tone) ? tone : 'casual';
    const lengthKey = LENGTH_KEYS.has(captionLength) ? captionLength : 'short';
    const languageKey = LANGUAGE_KEYS.has(outputLanguage)
        ? outputLanguage
        : (outputLanguage === 'Chinese' ? '中文' : 'English');
    const platformKey = PLATFORM_KEYS.has(platform) ? platform : 'instagram';
    const isRed = platformKey === 'xiaohongshu';

    const proBlock = isPro && typeof description === 'string' && description.trim() !== '' ? `
        PRO CONTEXT — VENDOR-PROVIDED:
        Vendor's Own Description: "${description}"

        Weave any factual ingredient/origin/process details from the vendor's description into the caption naturally — do not quote it verbatim and do not invent details the vendor did not state.
    ` : '';

    const stallBlock = buildStallBlock({ location, hours, contact });

    const trimmedChange = (changePrompt || '').trim();
    const changeBlock = trimmedChange === ''
        ? `The vendor did not provide specific guidance — produce a different take on the same caption that varies word choice, sentence structure, and angle while staying faithful to the dish, language, tone, and the platform rule above.`
        : `The vendor wants this change applied: "${trimmedChange}". Apply it to the caption while keeping it faithful to the platform rule above.`;

    const prompt = `
        You are an expert Malaysian social media copywriter for food vendors. The vendor has a working caption (below) for ${platformKey.toUpperCase()} and wants to refine it. Produce a single refined caption for this platform only.

        Context:
        Dish Name: ${dishName}
        Price: ${price}
        Output Language: ${languageKey}
        ${proBlock}
        ${stallBlock}

        UNIVERSAL RULES:
        1. CURRENCY: Always use "RM" (e.g., RM 13.50). Never use "$".
        2. CONTRACTIONS: Use them naturally ("we're", "it's", "that's").
        3. NO ADJECTIVE STACKING: One adjective per noun, max.
        4. VARY SENTENCE OPENINGS.
        5. NO GENERIC ENGAGEMENT FILLER ("Let us know in the comments!", "Drop a 🔥 below", etc).
        6. BANNED WORDS — never use any of: "Indulge", "Exquisite", "Harmonious", "Whimsical", "Delightful", "Elevate", "Symphony", "Serene", "Savour", "Aromatic", "Companion", "Experience", "Viral", "Journey", "Realm", "Transformative", "Masterpiece", "Adventure", "Culinary", "Palate".

        TONE — governs the caption voice (ignored for the delivery menu):
        ${TONE_RULES[toneKey]}

        LENGTH — a guide for Instagram/Facebook; the PLATFORM rule below takes precedence where it conflicts:
        ${LENGTH_RULES[lengthKey]}

        PLATFORM RULE — the caption must follow this exactly:
        ${PLATFORM_RULES[platformKey]}

        OUTPUT LANGUAGE — write the caption in this ONE language style only:
        ${LANGUAGE_RULES[languageKey]}

        --- CURRENT CAPTION (vendor's working baseline) ---
        ${isRed ? `note title: "${currentDraft.noteTitle || ''}"\n        ` : ''}caption: "${currentDraft.caption || ''}"

        --- REFINEMENT INSTRUCTION ---
        ${changeBlock}

        Return the refined caption${isRed ? ' and note title' : ''} for ${platformKey.toUpperCase()} only.
    `;

    const properties = { caption: { type: "string" } };
    const required = ["caption"];
    if (isRed) {
        properties.noteTitle = { type: "string" };
        required.push("noteTitle");
    }
    const schema = { type: "object", properties, required, additionalProperties: false };

    return await generateWithCascade(prompt, schema, imageBuffer.toString("base64"), mimeType);
}

// Assistive-mode background-prompt refinement. Text-only LLM call (no image) —
// the original prompt already encodes the food's camera perspective from the
// first generation. Merges the original prompt with the vendor's change request
// into a single coherent bg-swap prompt that processImageBackground can consume.
export async function refineBackgroundPrompt(originalBackgroundPrompt, changePrompt) {
    const trimmedChange = (changePrompt || '').trim();
    const changeBlock = trimmedChange === ''
        ? `The vendor did not provide specific guidance — produce a variant of the original prompt with different lighting, surface texture, or depth-of-field details. Stay in the same overall aesthetic family.`
        : `The vendor wants this change: "${trimmedChange}". Incorporate it naturally without contradicting the original prompt's structure.`;

    const prompt = `
        You are a food-photography prompt engineer. The vendor has a background prompt for a background-swap API and wants to refine it. Produce ONE new background prompt that merges the original with the change request.

        Original background prompt:
        "${originalBackgroundPrompt || ''}"

        ${changeBlock}

        CRITICAL RULES:
        1. DO NOT describe the food itself — the food is already cut out.
        2. Preserve the original prompt's perspective regime — flatlay (surface only), table-level angle (surface filling the frame and receding, with NO separate vertical background or wall), or profile/low angle (surface plus a blurred standing background). You have no image here, so keep whichever spatial layout the original prompt already expresses; do not switch regimes.
        3. Keep surface, lighting, and mood details concrete — avoid vague adjectives.
        4. Return ONE single coherent prompt as the backgroundPrompt field. Do not return alternatives or commentary.
    `;

    const schema = {
        type: "object",
        properties: {
            backgroundPrompt: { type: "string" }
        },
        required: ["backgroundPrompt"],
        additionalProperties: false
    };

    return await generateWithCascade(prompt, schema);
}

// Upscale-only operation set. Claid's editing API bills PER applied AI operation,
// so the old chain (upscale + polish + adjustments) cost 3 credits per enhance.
// `polish` (AI sharpen) and the `adjustments` block (hdr/sharpness/saturation) were
// each a separate billed op and are now reproduced client-side for free — the tonal
// pop via the adaptive local-enhance bake (recommendLocalEnhance → createProcessedBlob)
// and crispness via a sharpen convolution. `upscale: smart_enhance` is the only op kept
// because ML super-resolution (rendering genuinely new pixels) can't be faked on canvas.
// `decompress` + `resizing` are free/bundled (never billed) — resizing is load-bearing:
// `upscale` is a no-op without target dimensions.
const CLAID_FOOD_OPERATIONS = {
    "restorations": {
        "decompress": 'auto',
        "upscale": 'smart_enhance'
    },
    "resizing": {
        "width": "120%",
        "height": "120%",
    }
};

// `output` is a TOP-LEVEL sibling of `operations` in Claid's EditRequest — NOT a
// key inside operations. Claid's operations schema is additionalProperties:false,
// so nesting `output` there makes Claid reject the whole request with a 400.
const CLAID_OUTPUT = {
    format: { type: 'jpeg', quality: 90 }
};

export async function enhanceImageWithClaid(imageBuffer, mimeType, abortSignal) {
    if (!process.env.CLAID_API_KEY) {
        throw new Error('CLAID_API_KEY is not set');
    }

    const formData = new FormData();
    formData.append('file', imageBuffer, { filename: `upload.${mimeType.split('/')[1] || 'jpg'}`, contentType: mimeType });
    formData.append('data', JSON.stringify({ operations: CLAID_FOOD_OPERATIONS, output: CLAID_OUTPUT }));

    // Step 1: upload + process. /v1/image/edit/upload returns JSON with a tmp_url —
    // NOT the binary. The /v1-ext/... path does not exist (returns 404).
    let uploadResponse;
    try {
        uploadResponse = await axios.post('https://api.claid.ai/v1/image/edit/upload', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${process.env.CLAID_API_KEY}`,
            },
            timeout: 30000,
            signal: abortSignal,
        });
    } catch (err) {
        // Claid returns a JSON error body. axios auto-parses it into an object, so a
        // plain .toString() upstream yields "[object Object]" and hides the reason.
        // Decode it into a readable Error here (mirrors decodePhotoroomError).
        throw decodeClaidError(err);
    }

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

// Segmentation strategy: send NO segmentation params and rely on Photoroom's
// DEFAULT segmentation, which keeps the image's salient object — exactly the
// goal of cutting out "whatever the model deems the main subject" (dish, held
// drink with hand+arm, or an intentional person) without pinning a "food dish"
// prompt. The vendor still judges the result in the mask preview.
//
// Why not segmentation.mode=keepSalientObject: per Photoroom's docs that mode is
// an ADD-ON to text-guided segmentation — it keeps the salient object "in
// addition to the prompt" — so /v2/edit rejects it when no segmentation.prompt
// is supplied ("missing segmentation prompt"). The default segmentation already
// keeps "what the default segmentation would have kept" (the salient object), so
// keepSalientObject is redundant for us and only useful alongside a prompt.
// Both /v2/edit (main pipeline) and /v1/segment (mask preview) use the default,
// so the preview faithfully predicts the generate.

export async function processImageBackground(imageBuffer, originalName, backgroundPrompt, abortSignal, options = {}) {
    const { seed } = options;

    // Phase 6.7.4 — deterministic-seed support. We always pick a seed locally
    // (random uint32 when caller didn't supply one) rather than relying on
    // Photoroom to echo one back, so the response shape is consistent and
    // "fix this variant" can replay the exact integer next call.
    const seedToUse = Number.isInteger(seed) && seed >= 0
        ? seed
        : Math.floor(Math.random() * 0xFFFFFFFF);

    // Photoroom 400s on an empty background.prompt. The LLM is told to return
    // "N/A" when bg generation is off, but defensively guard here too so a blank
    // or sentinel prompt fails loudly with a clear message instead of an opaque
    // 400 from the image API.
    const prompt = (backgroundPrompt || '').trim();
    if (!prompt || prompt.toUpperCase() === 'N/A') {
        throw new Error('Background prompt is empty — the copy model did not return a usable backgroundPrompt.');
    }

    const formData = new FormData();
    formData.append('imageFile', imageBuffer, { filename: originalName || 'upload.png' });
    formData.append('background.prompt', prompt);
    formData.append('referenceBox', 'originalImage');
    formData.append('background.expandPrompt.mode', 'ai.never');
    formData.append('background.seed', String(seedToUse));
    // No segmentation.* params — default segmentation keeps the salient subject.
    // Background is text-only: background.prompt (from the LLM) is the sole
    // background signal — no image guidance (see CLAUDE.md Phase 6.7).

    let response;
    try {
        response = await axios.post(process.env.IMAGE_PROCESSING_API_URL, formData, {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
                'x-api-key': `${process.env.IMAGE_PROCESSING_API_KEY}`,
                'pr-ai-background-model-version': `background-studio-beta-2025-03-17`,
            },
            responseType: 'arraybuffer',
            timeout: 15000,
            signal: abortSignal
        });
    } catch (err) {
        // responseType:'arraybuffer' makes axios stash Photoroom's JSON error as a
        // Buffer on err.response.data — which has no .message, so the generic
        // "Request failed with status code 400" is all that surfaced upstream.
        // Decode it here so the real reason ("background.prompt must not be empty",
        // bad param, etc.) reaches the logs and the job's error field.
        throw decodePhotoroomError(err);
    }

    return {
        imageBase64: Buffer.from(response.data, 'binary').toString('base64'),
        seed: seedToUse,
    };
}

// Photoroom replies to errors with a small JSON body. When the request used
// responseType:'arraybuffer', axios leaves that body as a Buffer on
// err.response.data. Decode it to a readable Error so callers don't log an
// opaque byte dump. Falls back to the original error if there's nothing to read.
function decodePhotoroomError(err) {
    const data = err?.response?.data;
    if (!data) return err;
    try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        let detail = text;
        try {
            const parsed = JSON.parse(text);
            detail = parsed.error?.message || parsed.detail || parsed.message || text;
        } catch { /* not JSON — use raw text */ }
        const status = err.response?.status;
        const wrapped = new Error(`Photoroom ${status || ''} ${detail}`.trim());
        wrapped.status = status;
        wrapped.cause = err;
        return wrapped;
    } catch {
        return err;
    }
}

// Claid replies to errors with a JSON body. The upload POST uses the default
// (JSON) responseType, so axios leaves err.response.data as a parsed OBJECT —
// a plain .toString() on it yields "[object Object]". Decode it into a readable
// Error so the real reason ("validation error", a bad operations key, etc.)
// reaches the logs. Falls back to the original error if there's nothing to read.
function decodeClaidError(err) {
    const data = err?.response?.data;
    if (!data) return err;
    try {
        let detail;
        if (Buffer.isBuffer(data)) {
            detail = data.toString('utf8');
        } else if (typeof data === 'object') {
            // Pull a human field if Claid provides one, else serialize the body.
            detail = data.error_message || data.detail || data.message || JSON.stringify(data);
        } else {
            detail = String(data);
        }
        const status = err.response?.status;
        const wrapped = new Error(`Claid ${status || ''} ${detail}`.trim());
        wrapped.status = status;
        wrapped.cause = err;
        return wrapped;
    } catch {
        return err;
    }
}