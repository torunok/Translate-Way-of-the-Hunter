
import { TranslationItem } from "../types";

export class DeepLTranslator {
  /**
   * Translates a batch of items using DeepL API.
   * Uses XML tag injection to provide glossary context to the engine.
   */
  async translateBatch(
    items: TranslationItem[], 
    apiKey?: string,
    glossaryJson: string = "{}"
  ): Promise<{ id: number; translation: string; confidence: number; critique?: string }[]> {
    
    if (!apiKey) {
        throw new Error("DeepL API Key is missing.");
    }

    // Parse Glossary
    let glossary: Record<string, string> = {};
    try {
        glossary = JSON.parse(glossaryJson);
    } catch (e) {
        console.warn("DeepL Service: Failed to parse glossary JSON", e);
    }
    const glossaryEntries = Object.entries(glossary);

    // Prepare text with context injection
    // Strategy: We prepend "<glue>Term=Translation</glue>" and tell DeepL to ignore 'glue' tags.
    // DeepL sees the context but outputs the tag untranslated, allowing us to strip it later.
    const processedItems = items.map(item => {
        const source = item.source;
        // Find matching glossary terms in this specific string
        const matches = glossaryEntries.filter(([eng, _]) => {
            // Simple word boundary check to avoid partial matches (e.g. 'car' in 'carpet')
            // Escaping regex special chars is a good practice, simplifying here for performance
            const regex = new RegExp(`\\b${eng}\\b`, 'i');
            return regex.test(source);
        });

        let textToSend = source;
        if (matches.length > 0) {
            // Construct context string: "Chamois=Козиця; Elk=Вапіті"
            const contextStr = matches.map(([eng, ua]) => `${eng}=${ua}`).join('; ');
            // Prepend XML context
            textToSend = `<glue>${contextStr}</glue> ${source}`;
        }

        return {
            id: item.id,
            originalSource: source,
            textToSend,
            hasGlossaryMatch: matches.length > 0,
            matches: matches.map(m => m[0]) // Store which terms matched for logging/debug if needed
        };
    });

    const isFree = apiKey.endsWith(':fx');
    const endpoint = isFree 
        ? 'https://api-free.deepl.com/v2/translate' 
        : 'https://api.deepl.com/v2/translate';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: processedItems.map(p => p.textToSend),
          target_lang: 'UK', // Ukrainian
          tag_handling: 'xml', // Enable XML processing
          ignore_tags: ['glue'], // Tell DeepL NOT to translate content inside <glue>
        })
      });

      if (!response.ok) {
        if (response.status === 403) throw new Error("DeepL Auth Failed (Check Key)");
        if (response.status === 456) throw new Error("DeepL Quota Exceeded");
        if (response.status === 429) throw new Error("RATE_LIMIT");
        const errText = await response.text();
        throw new Error(`DeepL Error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      
      return data.translations.map((t: any, index: number) => {
        const meta = processedItems[index];
        let cleanedTranslation = t.text;

        // Clean up the XML tag from response if DeepL preserved it (it usually does)
        // Regex looks for <glue>...</glue> and removes it, plus any leading whitespace
        cleanedTranslation = cleanedTranslation.replace(/<glue>.*?<\/glue>\s*/gi, '');

        // Infer confidence
        // If we had glossary matches, we are more confident (100%).
        // Standard DeepL translation is usually high quality, say 90-95%.
        const confidence = meta.hasGlossaryMatch ? 100 : 90;

        return {
          id: Number(meta.id),
          translation: cleanedTranslation.trim(),
          confidence: confidence,
          // We don't get a critique from DeepL, but we can leave a note if glossary was used
          critique: meta.hasGlossaryMatch 
            ? `Used glossary terms: ${meta.matches.join(', ')}` 
            : undefined
        };
      });

    } catch (error: any) {
      throw error;
    }
  }
}
