const MIN_PASSAGE_CHARS = 40;
/**
 * Split a long text into overlapping passages around ~targetChars, preferring
 * to cut at sentence boundaries (both Latin and CJK terminators).
 */
export function splitPassages(text, targetChars = 1300, overlapChars = 160) {
    const clean = (text ?? '').replace(/\u0000/g, '').trim();
    if (!clean)
        return [];
    if (clean.length <= targetChars)
        return [clean];
    const isSentenceEnder = (ch) => '.!?。！？'.includes(ch);
    const passages = [];
    let start = 0;
    while (start < clean.length) {
        let end = Math.min(clean.length, start + targetChars);
        if (end < clean.length) {
            const window = clean.slice(start, end);
            // Look for the last sentence terminator in the trailing 40% of the window.
            const searchFrom = Math.floor(window.length * 0.6);
            let cut = -1;
            for (let i = window.length - 1; i >= searchFrom; i--) {
                if (isSentenceEnder(window[i])) {
                    cut = i + 1;
                    break;
                }
            }
            if (cut > 0)
                end = start + cut;
        }
        const piece = clean.slice(start, end).trim();
        if (piece.length >= MIN_PASSAGE_CHARS || passages.length === 0)
            passages.push(piece);
        if (end >= clean.length)
            break;
        start = Math.max(end - overlapChars, start + 1);
    }
    return passages;
}
const STOPWORDS = new Set([
    // English
    'the', 'of', 'and', 'in', 'to', 'a', 'is', 'for', 'on', 'with', 'as', 'by', 'that', 'this',
    'from', 'at', 'are', 'be', 'we', 'it', 'an', 'was', 'were', 'or', 'not', 'which', 'their',
    'its', 'can', 'has', 'have', 'had', 'than', 'then', 'these', 'those', 'into', 'also',
    // CJK function characters
    '的', '了', '是', '在', '和', '有', '与', '及', '或', '对', '等', '之', '中', '为',
]);
/**
 * Tokenize mixed Latin/CJK text: lowercase Latin words plus CJK character
 * bigrams (CJK has no whitespace word boundaries).
 */
export function tokenize(text) {
    const terms = [];
    for (const word of (text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'’\-]*/g) ?? []) {
        if (word.length >= 2 && !STOPWORDS.has(word))
            terms.push(word);
    }
    for (const run of (text ?? '').match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []) {
        if (run.length === 1) {
            if (!STOPWORDS.has(run))
                terms.push(run);
            continue;
        }
        for (let i = 0; i < run.length - 1; i++) {
            const bigram = run.slice(i, i + 2);
            if (!STOPWORDS.has(bigram))
                terms.push(bigram);
        }
    }
    return terms;
}
const MAX_PASSAGES_FOR_SCORING = 600;
/**
 * Rank passages against a query with a light BM25-style tf-idf overlap score.
 * Returns passages sorted by score descending (stable for ties: earlier wins).
 */
export function scorePassages(passages, query) {
    const pool = passages.slice(0, MAX_PASSAGES_FOR_SCORING);
    if (pool.length === 0)
        return [];
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
        return pool.map((p, index) => ({ ...p, score: pool.length - index }));
    }
    const docTerms = pool.map((p) => tokenize(p.text));
    const docFreq = new Map();
    for (const terms of docTerms) {
        for (const term of new Set(terms))
            docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
    const idf = (term) => Math.log(1 + pool.length / (docFreq.get(term) ?? 0));
    const scored = pool.map((passage, index) => {
        const tf = new Map();
        for (const term of docTerms[index])
            tf.set(term, (tf.get(term) ?? 0) + 1);
        let score = 0;
        for (const term of queryTerms) {
            const freq = tf.get(term);
            if (!freq)
                continue;
            score += (1 + Math.log(freq)) * idf(term);
        }
        // Small bonus when the passage contains an exact phrase fragment of the query.
        const phrase = query.trim().toLowerCase();
        if (phrase.length >= 8 && passage.text.toLowerCase().includes(phrase))
            score += 1.5;
        return { ...passage, score: Math.round(score * 1000) / 1000 };
    });
    return scored.sort((a, b) => b.score - a.score);
}
/** Derive a fallback query from an item title (drop stopwords, cap length). */
export function queryFromTitle(title) {
    const words = tokenize(title);
    return words.slice(0, 12).join(' ') || title.slice(0, 80);
}
