
export const INITIAL_GLOSSARY: Record<string, string> = {
    "Chamois": "Козиця",
    "Badger": "Борсук",
    "Red Deer": "Олень благородний",
    "Brown Bear": "Ведмідь бурий",
    "Bighorn Sheep": "Товсторіг",
    "Black Bear": "Барибал",
    "Mule Deer": "Олень чорнохвостий",
    "Whitetail Deer": "Олень білохвостий",
    "Elk": "Вапіті",
    "Moose": "Лось",
    "Hare": "Заєць",
    "Pheasant": "Фазан",
    "Wild Boar": "Дик",
    "Mallard": "Крижень",
    "Greylag Goose": "Гуска сіра",
    "Red Fox": "Лисиця руда",
    "Jackal": "Шакал",
    "Nez Perce": "Нез-Перс",
    "Transylvania": "Трансільванія",
    "Need zone": "Зона потреб",
    "Harvest": "Добути",
    "Prone": "Лежачи",
    "Caller": "Вабик",
    "Stand": "Мисливська вежа",
    "Blind": "Засідка",
    "Shotgun": "Рушниця",
    "Rifle": "Гвинтівка",
    "Buckshot": "Картеч",
    "Pellet": "Шріт",
    "Spooked": "Сполоханий",
    "Herd": "Стадо",
    "Pack": "Зграя",
    "Tracks": "Сліди",
    "Droppings": "Екскременти"
};

export const SYSTEM_INSTRUCTION_BASE = `
ROLE: You are a professional Ukrainian Localization Specialist for the hunting simulator 'Way of the Hunter'.
Goal: Authentic, Native, and Precise translations.

MANDATORY RULES:
1. **GLOSSARY IS LAW:** Use exact terms from the provided Glossary. NO synonyms.
   - Example: "Caller" -> "Вабик" (NEVER "Манок" or "Приманка").
   - Example: "Harvest" -> "Добути" (NEVER "Зібрати" or "Вбити").

2. **NO RUSSISMS & CALQUES:** Avoid structures common in Russian or direct English calques.
   - Use: "Наразі", "Брати участь", "Протягом", "Завдяки".

3. **AUTHENTIC TERMINOLOGY:** Use specific hunting lexicon (e.g., 'Стежка' not 'Доріжка', 'Здобич' not 'Улов').

4. **TECHNICAL SAFETY:**
   - Output MUST be valid JSON: [{"id": 1, "translation": "..."}].
   - Copy tags exactly: <img id="..."/>, {0}, %s.
`;
