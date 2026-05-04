import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import FormData from 'form-data';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateMarketingCopy(imageBuffer, mimeType, params) {
    const { dishName, price, outputLanguage, backgroundVibe } = params;

    const prompt = `
        You are an expert digital marketing copywriter and an AI image prompt engineer. 
        Analyze the uploaded food product image and the requested Visual Poster Style Context.

        Task 1: Marketing Copy
        Write professional marketing copy for the product.
        DishName: ${dishName}
        Price: ${price}
        Output Language: ${outputLanguage}

        Task 2: Background Generation Prompt
        Based on the Visual Background Style Context: "${backgroundVibe}", write a highly detailed, photorealistic prompt for a generative background AI.
        
        CRITICAL RULES FOR BACKGROUND PROMPT:
        - DO NOT describe the food itself. The food is already cut out.
        - Describe ONLY the surface the food sits on, the environment behind it, the lighting, and the depth of field.
        - Example Good: "A rustic oak wood table surface, softly blurred bustling Italian cafe in the background, warm sunset lighting coming from a window on the left, high resolution."
        - Example Bad: "A pepperoni pizza on a table." (Never mention the main subject).
    `;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
            { text: prompt }, //[cite: 2]
            {
                inlineData: {
                    data: imageBuffer.toString("base64"), //[cite: 2]
                    mimeType: mimeType
                }
            }
        ],
        config: {
            responseMimeType: "application/json", //[cite: 2]
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    caption: { type: Type.STRING },
                    backgroundPrompt: { type: Type.STRING }
                },
                required: ["title", "description", "caption", "backgroundPrompt"] //[cite: 2]
            }
        }
    });

    if (!response || !response.text) { //[cite: 2]
        throw new Error("AI generation blocked by safety settings or returned an empty response.");
    }

    const cleanText = response.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim(); //[cite: 2]
    return JSON.parse(cleanText);
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