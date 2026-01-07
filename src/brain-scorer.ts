/**
 * Mantic Engine v2
 * High-performance, structural code search engine.
 * 
 * Key Features:
 * 1. Soft AND Filtering (Penalty-based)
 * 2. Pre-computed Index (Zero allocation in hot path)
 * 3. Structural Awareness (Filename == Parent Directory)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { IntentAnalysis, CacheIndex, FileScore } from './types.js';

interface FileEntry {
    original: string;
    lower: string;
    fileName: string;
    fileNameLower: string;
    parentDirLower: string;
    ext: string;
    depth: number;
}

interface SearchResult {
    file: string;
    score: number;
    matchType: 'exact' | 'filename' | 'fuzzy';
}

const EXTENSION_WEIGHTS: Record<string, number> = {
    '.ts': 20, '.tsx': 20, '.js': 15, '.jsx': 15,
    '.rs': 20, '.go': 20, '.py': 15, '.php': 15,
    '.prisma': 15, '.graphql': 10,
    '.css': 5, '.json': 5, '.md': 2
};

export class ManticEngine {
    private index: FileEntry[] = [];
    private cache: CacheIndex | null = null;

    constructor(cache?: CacheIndex) {
        this.cache = cache || null;
    }

    /**
     * Builds the search index from a list of file paths.
     * This moves expensive string operations out of the search loop.
     */
    buildIndex(filePaths: string[]) {
        this.index = filePaths.map(p => {
            const parts = p.split(/[/\\]/);
            const fileName = parts[parts.length - 1];
            // Get parent directory (if exists), otherwise empty
            const parentDir = parts.length > 1 ? parts[parts.length - 2] : '';
            const lower = p.toLowerCase();

            return {
                original: p,
                lower: lower,
                fileName: fileName,
                fileNameLower: fileName.toLowerCase(),
                parentDirLower: parentDir.toLowerCase(),
                ext: fileName.includes('.') ? '.' + fileName.split('.').pop()! : '',
                depth: parts.length
            };
        });
    }

    /**
     * The hot path search function.
     * Optimized for V8 performance.
     */
    search(query: string, limit = 100): SearchResult[] {
        if (!query) return [];

        const queryLower = query.toLowerCase().trim();
        const terms = queryLower.split(/\s+/).filter(Boolean);

        if (terms.length === 0) return [];

        const results: SearchResult[] = [];

        for (let i = 0; i < this.index.length; i++) {
            const entry = this.index[i];
            const score = this.scoreEntry(entry, terms, queryLower);

            if (score > 0) {
                results.push({
                    file: entry.original,
                    score,
                    matchType: score > 150 ? 'exact' : 'fuzzy'
                });
            }
        }

        return results
            .sort((a, b) => {
                // Primary Sort: Score (Descending)
                if (b.score !== a.score) return b.score - a.score;
                // Secondary Sort: Path Length (Ascending) - Shortest wins
                return a.file.length - b.file.length;
            })
            .slice(0, limit);
    }

    /**
     * Legacy compatibility method for process-request.ts
     * Maps the new search output to the old FileScore[] format
     */
    async rankFiles(
        files: string[],
        keywords: string[],
        intent: IntentAnalysis,
        projectRoot: string
    ): Promise<FileScore[]> {
        // Build index if not already built or file count mismatch
        if (this.index.length === 0 || this.index.length !== files.length) {
            this.buildIndex(files);
        }

        const query = keywords.join(' ');
        const results = this.search(query);

        return results.map(r => ({
            path: r.file,
            score: r.score,
            reasons: r.matchType === 'exact' ? ['exact-match']
                : r.matchType === 'filename' ? ['filename-match']
                    : ['keyword-match']
        }));
    }

    private scoreEntry(entry: FileEntry, terms: string[], fullQuery: string): number {
        let score = 0;

        // A. INTERSECTION CHECK (Soft AND)
        // Add points for matches, penalize misses
        let termsmatched = 0;
        for (let i = 0; i < terms.length; i++) {
            if (entry.lower.includes(terms[i])) {
                termsmatched++;
                score += 10; // Base points per match
            } else {
                score -= 50; // Heavy penalty for missing term
            }
        }

        // Base score adjustment (buffer against negative scores)
        score += 50;

        // B. EXACT FILENAME MATCH
        if (entry.fileNameLower === fullQuery) {
            return 1000;
        }

        // C. STRUCTURAL SPECIFICITY
        // Reward matches in Filename and Parent Directory equally
        let termsInStructure = 0;
        for (const term of terms) {
            if (entry.fileNameLower.includes(term)) {
                score += 30; // Filename match
                termsInStructure++;
            } else if (entry.parentDirLower.includes(term)) {
                score += 30; // Parent Dir match (Equal weight)
                termsInStructure++;
            } else {
                score += 5; // Loose path match
            }
        }

        // Structural Bonus: All terms matched in high-value spots
        if (termsInStructure === terms.length) {
            score += 50;
        }

        // D. ADJACENCY BONUS
        if (entry.lower.includes(fullQuery.replace(/\s/g, ''))) {
            score += 20;
        }

        // E. EXTENSION PRIORITIZATION
        score += (EXTENSION_WEIGHTS[entry.ext] || 0);

        return Math.max(0, score);
    }
}
