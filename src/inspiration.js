export function compactText(value, limit = 100) {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    const characters = Array.from(text);
    return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text;
}

export function greetingForHour(hour, displayName = '') {
    const period = hour >= 5 && hour < 12 ? 'MORNING'
        : hour >= 12 && hour < 17 ? 'AFTERNOON' : 'EVENING';
    const name = compactText(displayName, 32).toUpperCase();
    return `GOOD ${period}${name ? `, ${name}` : ''}`;
}

export function loadVerses(file) {
    try {
        const [, bytes] = file.load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return Array.isArray(data.verses) ? data.verses.filter((verse) => verse &&
            ['id', 'reference', 'text', 'category'].every((key) =>
                typeof verse[key] === 'string' && verse[key].trim()) && verse.translation === 'KJV') : [];
    } catch (_error) {
        return [];
    }
}

export function selectDailyVerse(localDate, verses) {
    if (!Array.isArray(verses) || verses.length === 0 ||
        typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate))
        return null;
    // The caller supplies the LOCAL calendar date. UTC is used only for
    // calendar-day arithmetic, so DST and process restarts do not change it.
    const day = Math.floor(Date.parse(`${localDate}T00:00:00Z`) / 86400000);
    return Number.isFinite(day) ? verses[((day % verses.length) + verses.length) % verses.length] : null;
}
