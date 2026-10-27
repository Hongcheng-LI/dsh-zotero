export type PassageSource = 'fulltext' | 'notes' | 'annotations';
export type PassageInput = {
    source: PassageSource;
    text: string;
    page?: number;
    pageLabel?: string;
    attachmentKey?: string;
    noteKey?: string;
    annotationKey?: string;
};
export type ScoredPassage = PassageInput & {
    score: number;
};
/**
 * Split a long text into overlapping passages around ~targetChars, preferring
 * to cut at sentence boundaries (both Latin and CJK terminators).
 */
export declare function splitPassages(text: string, targetChars?: number, overlapChars?: number): string[];
/**
 * Tokenize mixed Latin/CJK text: lowercase Latin words plus CJK character
 * bigrams (CJK has no whitespace word boundaries).
 */
export declare function tokenize(text: string): string[];
/**
 * Rank passages against a query with a light BM25-style tf-idf overlap score.
 * Returns passages sorted by score descending (stable for ties: earlier wins).
 */
export declare function scorePassages(passages: PassageInput[], query: string): ScoredPassage[];
/** Derive a fallback query from an item title (drop stopwords, cap length). */
export declare function queryFromTitle(title: string): string;
