import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import FormData from 'form-data';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateMarketingCopy(imageBuffer, mimeType, params) {
    const { dishName, price, outputLanguage, backgroundVibe } = params;

    let backgroundVibeString = "";

    switch (backgroundVibe.id) {
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

    const prompt = `
        You are an expert Malaysian social media manager and an AI image prompt engineer. 
        Analyze the uploaded food product image.

        Context:
        Dish Name: ${dishName}
        Price: ${price}
        Output Language: ${outputLanguage}
        Background Vibe: ${backgroundVibeString}

        --- TASK 1: COPYWRITING (Title, Description, Caption) ---
        CRITICAL RULES FOR ALL TEXT:
        1. CURRENCY: Always use "RM" (e.g., RM 13.50). Never use "$".
        2. TONE: Hungry, casual, and energetic. Must sound like a real Malaysian foodie, not a corporate brochure. 
        3. BANNED WORDS: Do NOT use generic AI words like: "Indulge", "Exquisite", "Harmonious", "Whimsical", "Delightful", "Elevate", "Symphony", "Serene".

        Provide the text for these specific fields:
        - title: A short, punchy name for the dish (max 3-5 words).
        - description: A 1-2 sentence description suitable for a digital menu. Keep it grounded, focusing on taste, texture, and ingredients.
        - caption: A 3-sentence social media caption designed to drive foot traffic. 
          Format: [Catchy Hook/Emoji] + [1 Sentence describing the best part of the food] + [Urgency/Call to Action with Price]. 
          *Note: If Output Language is "Local Style", use casual Malaysian slang (e.g., 'Ngam ngam', 'Padu'). If "English", use casual English.*

        --- TASK 2: BACKGROUND GENERATION PROMPT ---
        Determine the camera perspective of the uploaded food image:
        - Is it a Top-Down (flatlay) shot pointing straight down?
        - Or is it an Angled/Profile shot showing depth?

        Write the 'backgroundPrompt' based on the perspective and the Background Vibe ("${backgroundVibeString}").
        
        CRITICAL RULES FOR BACKGROUND PROMPT:
        1. DO NOT describe the food itself. The food is already cut out.
        2. IF TOP-DOWN: Describe ONLY a flat surface texture directly beneath the food. Do NOT mention a background, room, or depth of field.
        3. IF ANGLED: Describe the surface beneath the food AND a softly blurred environment behind it to create depth.
    `;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
            { text: prompt },
            {
                inlineData: {
                    data: imageBuffer.toString("base64"),
                    mimeType: mimeType
                }
            }
        ],
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    caption: { type: Type.STRING },
                    backgroundPrompt: { type: Type.STRING }
                },
                required: ["title", "description", "caption", "backgroundPrompt"]
            }
        }
    });

    if (!response || !response.text) {
        throw new Error("AI generation blocked by safety settings or returned an empty response.");
    }

    const cleanText = response.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(cleanText);

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