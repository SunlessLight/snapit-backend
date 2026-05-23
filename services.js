import axios from 'axios';
import FormData from 'form-data';
import { generateWithCascade } from './llmCascade.js';

export async function generateMarketingCopy(imageBuffer, mimeType, params) {
    const {
        dishName, price, outputLanguage, backgroundVibe, generateBackground,
        isContextPro, description, tone, backgroundDescription
    } = params;
    const shouldGenerateBg = generateBackground === 'true';
    const isPro = isContextPro === 'true';
    const hasProBgDescription = isPro && shouldGenerateBg
        && typeof backgroundDescription === 'string'
        && backgroundDescription.trim() !== '';

    const proBlock = isPro ? `
        PRO CONTEXT — VENDOR-PROVIDED:
        Tone Preference: ${tone}
        Vendor's Own Description: "${description}"

        When writing the title, description, and caption, lean into the "${tone}" tone (e.g., "luxury" = restrained and elegant; "funny" = playful, light jokes; "cozy" = warm and homey; "casual" = relaxed; "modern" = clean and current; "professional" = polished but never stiff). Weave any factual ingredient/origin details from the vendor's description into the description and caption naturally — do not quote it verbatim. The BANNED WORDS list below still applies regardless of tone.
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
        You are an expert Malaysian social media manager and an AI image prompt engineer. 
        Analyze the uploaded food product image.

        Context:
        Dish Name: ${dishName}
        Price: ${price}
        Output Language: ${outputLanguage}
        Background Vibe: ${backgroundVibeString}
        ${proBlock}
        --- TASK 1: COPYWRITING (Title, Description, Caption) ---
        CRITICAL RULES FOR ALL TEXT:
        1. CURRENCY: Always use "RM" (e.g., RM 13.50). Never use "$".
        2. TONE & PERSONA: Speak like a friendly local stall owner or a hungry friend recommending a food spot. Zero marketing fluff. Be direct and appetizing. Do NOT sound like a luxury hotel brochure.
        3. BANNED WORDS: Do NOT use any of these generic AI marketing words: "Indulge", "Exquisite", "Harmonious", "Whimsical", "Delightful", "Elevate", "Symphony", "Serene", "Savour", "Aromatic", "Companion", "Experience", "Viral", "Journey", "Realm".

        Provide the text for these specific fields:
        - title: A short, punchy, realistic name for the dish (max 3-5 words). Keep it simple (e.g., "Crispy Fish Noodle Soup", NOT "Exquisite Fish Noodle Symphony").
        - description: A 1-2 sentence digital menu description. Focus PURELY on factual taste, texture, and ingredients. No emotional fluff.
        - caption: A highly readable, structured social media caption designed to stop scrollers and transfer info quickly. 
          
          Use this EXACT structure with line breaks:
          [Catchy Hook/Emoji: 1 short sentence to trigger a craving]
          🍲 Dish: [Name of Dish]
          💵 Price: RM [Price]
          [Call to Action: 1 short sentence creating urgency or inviting them over]

          *CRITICAL LANGUAGE RULES FOR CAPTION:*
          - If Output Language is "Local Style": Use heavy conversational Malaysian street slang/Manglish (e.g., 'Ngam ngam', 'Padu', 'Fuh', 'Memang layan') for the Hook and Call to Action.
          - If Output Language is "English": Write like a normal, everyday Malaysian speaking casual English. Keep it punchy and realistic.
          - If Output Language is "Bahasa Melayu": Write in casual conversational Malay as a friendly local stall owner would speak — warm, direct, no formal civil-service register.
          - If Output Language is "中文" or "Chinese": Write in casual Simplified Chinese as a friendly Malaysian Chinese vendor would speak — direct, appetizing, hawker-stall energy. Keep "RM" for price per CRITICAL RULE 1. Avoid Mainland-China-specific idioms; lean local/Malaysian-Chinese phrasing where natural.

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