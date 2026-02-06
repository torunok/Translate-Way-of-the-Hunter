import { GoogleGenAI, Type } from "@google/genai";
import { TranslationItem } from "../types";
import { SYSTEM_INSTRUCTION_BASE } from "../constants";

export class GeminiTranslator {
  /**
   * Перекладає або валідує батч елементів.
   * Якщо елемент вже має переклад (наприклад, після ручного редагування), 
   * модель фокусується на його перевірці та покращенні.
   */
  async translateBatch(
    items: TranslationItem[], 
    glossaryJson: string, 
    apiKey?: string,
    model: string = 'gemini-3-flash-preview'
  ): Promise<{ id: number; translation: string; confidence: number; critique?: string }[]> {
    
    const key = apiKey || process.env.API_KEY;
    if (!key) {
        throw new Error("API Key is missing. Please enter it in the configuration.");
    }

    const ai = new GoogleGenAI({ apiKey: key });
    
    const systemInstruction = `${SYSTEM_INSTRUCTION_BASE}
    
    INSTRUCTIONS FOR VALIDATION:
    1. For each item, you are provided with 'source' and optionally 'currentTranslation'.
    2. If 'currentTranslation' is present, VALIDATE it. Check if it follows the GLOSSARY and hunting terminology.
    3. If 'currentTranslation' is excellent, return it as 'translation' with a high confidence score.
    4. If 'currentTranslation' has errors or sounds unnatural, provide a fixed version in 'translation' and explain the changes in 'critique'.
    5. Always return a 'confidence' score (0-100).
    
    GLOSSARY (Strict JSON):
    ${glossaryJson}`;
    
    const promptItems = items.map(item => ({
      id: Number(item.id),
      key: item.key,
      source: item.source,
      currentTranslation: item.target || null
    }));

    try {
      const response = await ai.models.generateContent({
        model,
        contents: `Process the following game strings. If a translation is provided, validate and improve it. Otherwise, translate from scratch:\n${JSON.stringify(promptItems)}`,
        config: {
          systemInstruction,
          temperature: 0.1, // Більш стабільні результати для валідації
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: {
                  type: Type.NUMBER,
                  description: 'ID елемента.'
                },
                translation: {
                  type: Type.STRING,
                  description: 'Фінальний варіант перекладу (оригінальний або виправлений).'
                },
                confidence: {
                  type: Type.NUMBER,
                  description: 'Рівень впевненості (0-100).'
                },
                critique: {
                  type: Type.STRING,
                  description: 'Пояснення правок або підтвердження якості.'
                }
              },
              required: ["id", "translation", "confidence"],
              propertyOrdering: ["id", "translation", "confidence", "critique"],
            },
          },
        },
      });

      const text = response.text;
      if (!text) throw new Error("Empty response from Gemini");
      
      return JSON.parse(text);
    } catch (error: any) {
      if (error.message?.includes("429") || error.message?.includes("RESOURCE_EXHAUSTED")) {
        throw new Error("RATE_LIMIT");
      }
      throw error;
    }
  }
}