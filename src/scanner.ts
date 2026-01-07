import fg from 'fast-glob';
import fs from 'fs/promises';
import path from 'path';
import { ProjectContext, ScanOptions, IntentAnalysis, IntentCategory, CacheIndex, SessionContext, FileScore } from './types.js';
import { CacheManager } from './cache.js';
import { FileParser } from './parser.js';
import { classifyProject } from './project-classifier.js';
import { SmartFilter } from './smart-filter.js';
import { getGitState, isGitRepo, getGitFiles } from './git-utils.js';
import { ManticEngine } from './brain-scorer.js';
import { getFileMetadataBatch, calculateConfidence } from './file-metadata.js';
import { NativeLoader } from './native-loader.js';

// Files to ignore to keep context clean and avoid system folders
const IGNORE_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.next/**',
    '**/dist/**',
    '**/build/**',
    '**/.DS_Store',
    '**/*.lock',
    '**/*.log',
    '**/Library/**',
    '**/Music/**',
    '**/Pictures/**',
    '**/Movies/**',
    '**/Desktop/**',
    '**/Documents/**', // Only if nested deeply
    '**/.mantic/**', // Ignore our own cache directory
    '**/.promptpro/**', // Ignore legacy cache directory
    // Python
    '**/venv/**',
    '**/.venv/**',
    '**/__pycache__/**',
    '**/*.pyc',
    '**/*.egg-info/**',
    // Rust
    '**/target/**',
    '**/.cargo/**',
    // Go
    '**/vendor/**',
    // General
    '**/tmp/**',
    '**/temp/**',
    '**/coverage/**',
    '**/.idea/**',
    '**/.vscode/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map'
];

/**
 * Get ignore patterns, including MANTIC_IGNORE_PATTERNS from env
 */
function getIgnorePatterns(): string[] {
    const envPatterns = process.env.MANTIC_IGNORE_PATTERNS;
    if (!envPatterns) {
        return IGNORE_PATTERNS;
    }

    const additionalPatterns = envPatterns
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);

    return [...IGNORE_PATTERNS, ...additionalPatterns];
}

/**
 * Get maximum files to return from env or default
 */
function getMaxFiles(): number {
    const envValue = process.env.MANTIC_MAX_FILES;
    if (envValue) {
        const parsed = parseInt(envValue, 10);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return 300; // Default
}

/**
 * Get timeout in milliseconds from env or default
 */
function getTimeout(): number {
    const envValue = process.env.MANTIC_TIMEOUT;
    if (envValue) {
        const parsed = parseInt(envValue, 10);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return 30000; // Default 30 seconds (increased for large repos like Chromium)
}

// Intent-based filtering: map categories to directory patterns
const INTENT_TO_PATHS: Record<IntentCategory, string[]> = {
    UI: ['components/**', 'src/components/**', 'app/**/*.tsx', 'pages/**/*.tsx', '**/ui/**'],
    auth: ['**/auth/**', '**/middleware/auth*', '**/lib/auth*', '**/api/**/auth*', '**/*auth*.ts', '**/*auth*.tsx'],
    styling: ['styles/**', '**/*.css', '**/*.scss', '**/tailwind*', '**/theme*', '**/*.module.css', '**/*.styled.*'],
    performance: ['utils/**', 'lib/**', 'hooks/**', 'middleware/**', '**/*optimize*', '**/*cache*'],
    backend: ['api/**', 'server/**', 'lib/**', 'services/**', 'models/**', 'db/**', '**/*route*', '**/actions/**'],
    testing: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx', 'tests/**', '__tests__/**', 'e2e/**'],
    config: ['*.config.js', '*.config.ts', '.env*', 'package.json', 'tsconfig.json', '**/*.config.*'],
    general: ['**/*'] // Match all files for general intent
};

// Intent-based filtering: map categories to keywords
const INTENT_TO_KEYWORDS: Record<IntentCategory, string[]> = {
    UI: ['button', 'modal', 'dialog', 'form', 'card', 'menu', 'dropdown', 'nav', 'header', 'footer'],
    auth: ['auth', 'login', 'signup', 'user', 'profile', 'session', 'password', 'token'],
    styling: ['theme', 'dark', 'light', 'color', 'style', 'css', 'tailwind', 'styled'],
    performance: ['loading', 'cache', 'optimize', 'lazy', 'memo', 'suspense'],
    backend: ['api', 'fetch', 'query', 'mutation', 'database', 'server', 'request', 'response'],
    testing: ['test', 'spec', 'jest', 'vitest', 'expect', 'mock', 'describe'],
    config: ['config', 'env', 'settings', 'setup', 'dependency'],
    general: []
};

/**
 * Estimate file count quickly without full scan
 * Uses early termination to avoid processing all files
 */
async function estimateFileCount(cwd: string): Promise<number> {
    let count = 0;
    const SAMPLE_LIMIT = 15000; // Stop counting after this many files

    const stream = fg.stream(['**/*'], {
        cwd,
        ignore: getIgnorePatterns(),
        dot: true,
        onlyFiles: true,
        suppressErrors: true,
        followSymbolicLinks: false,
        deep: 10
    });

    for await (const _entry of stream) {
        count++;
        if (count >= SAMPLE_LIMIT) {
            break; // Early termination for huge repos
        }
    }

    return count;
}

/**
 * Load session context from .mantic directory
 * This allows us to remember the last request and provide context carryover
 */
async function loadSessionContext(cwd: string): Promise<SessionContext> {
    try {
        const sessionFile = path.join(cwd, '.mantic', 'session.json');
        const data = await fs.readFile(sessionFile, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {}; // No session file yet
    }
}


// Git state function moved to git-utils.ts

/**
 * Save session context for next request
 */
async function saveSessionContext(cwd: string, context: SessionContext): Promise<void> {
    try {
        const sessionFile = path.join(cwd, '.mantic', 'session.json');
        await fs.mkdir(path.dirname(sessionFile), { recursive: true });
        await fs.writeFile(sessionFile, JSON.stringify(context, null, 2));
    } catch {
        // Ignore save errors
    }
}

/**
 * Scans the current directory to build the ProjectContext.
 * Now with optional caching support for faster subsequent runs.
 * This is the internal implementation - use scanProject() for timeout support.
 */
async function scanProjectInternal(
    cwd: string = process.cwd(),
    options: ScanOptions = {}
): Promise<ProjectContext> {
    const {
        useCache = true,
        forceRefresh = false,
        parseSemantics = true,
        intentAnalysis,
        onProgress,
        sessionBoosts
    } = options;

    const progress = (msg: string) => {
        if (onProgress) onProgress(msg);
    };

    // If cache disabled or semantics not needed, use fast legacy scan
    if (!useCache || !parseSemantics) {
        return scanProjectLegacyInternal(cwd, intentAnalysis, onProgress, sessionBoosts, options.skipScoring);
    }

    const startTime = Date.now();
    const cacheManager = new CacheManager(cwd);
    const parser = new FileParser();

    // LAZY PARSING OPTIMIZATION: Quick file count estimation
    // For monorepos (>10k files), skip AST parsing on first run
    let shouldUseLazyMode = false;
    const cacheExists = await cacheManager.exists();

    if (!cacheExists && !forceRefresh) {
        // Estimate file count quickly using fast-glob with early termination
        const estimatedCount = await estimateFileCount(cwd);

        if (estimatedCount > 10000) {
            shouldUseLazyMode = true;
            progress(`Monorepo detected (${estimatedCount.toLocaleString()}+ files) - using fast mode`);
        }
    }

    // Skip to legacy scan if lazy mode enabled
    if (shouldUseLazyMode) {
        return scanProjectLegacyInternal(cwd, intentAnalysis, onProgress, sessionBoosts, options.skipScoring);
    }

    // Try to load cache
    let cache = null;
    if (!forceRefresh) {
        cache = await cacheManager.load();
        if (cache && await cacheManager.shouldInvalidate(cache)) {
            cache = null; // Invalidate
        }
    }

    // Detect tech stack first
    const techStack = await detectTechStack(cwd);
    if (techStack && techStack !== 'Unknown') {
        const deps = techStack.split(', ');
        const formatted = formatDependencies(deps);
        progress(`Found package.json (${formatted})`);
    }

    // Get git state for context
    const gitState = getGitState(cwd);
    if (gitState) {
        progress('Captured git context');
    }

    // Get current file list
    // Get current file list using Native Loader (Git/Fd/Glob)
    // This handles caching regexes and selecting the fastest binary
    const loader = new NativeLoader(getIgnorePatterns());
    let files = await loader.loadFiles(cwd);

    // Fallback logic handled internally by loader
    progress(`Scanned ${files.length.toLocaleString()} files using NativeLoader`);

    // Analyze directory structure (Disabled for performance test)
    // const dirStats = analyzeDirectoryStructure(files);
    const dirStats = new Map<string, number>();
    progress('Skipped directory analysis');

    if (!cache) {
        // Full scan with AST parsing
        progress('Building semantic index (first run)...');
        cache = await cacheManager.buildFromScratch(files, techStack, parser);

        // Classify project type on first scan
        const allFiles = Object.keys(cache.files);
        cache.metadata = await classifyProject(allFiles, cache.techStack);
    } else {
        // Incremental update
        const changes = await cacheManager.getStaleFiles(cache, files);
        const totalChanges = changes.modified.length + changes.added.length + changes.deleted.length;

        if (totalChanges > 0) {
            progress(`Updating cache: ${totalChanges} file(s) changed...`);
            cache = await cacheManager.updateIncrementally(cache, changes, parser);
        }

        // Classify if not done yet
        if (!cache.metadata) {
            const allFiles = Object.keys(cache.files);
            cache.metadata = await classifyProject(allFiles, cache.techStack);
        }
    }

    // Show project type
    if (cache.metadata && cache.metadata.projectType !== 'unknown') {
        const typeDesc = cache.metadata.projectType;
        const caps = [];
        if (cache.metadata.hasUI) caps.push('UI');
        if (cache.metadata.hasBackend) caps.push('API');
        const capsStr = caps.length > 0 ? ` (${caps.join(', ')})` : '';
        progress(`Project type: ${typeDesc}${capsStr}`);
    }

    // Save updated cache
    await cacheManager.save(cache);

    // INTENT-BASED FILTERING: Apply if intent analysis provided and confidence is sufficient
    if (intentAnalysis && intentAnalysis.confidence > 0.5 && intentAnalysis.category !== 'general') {
        // Use SmartFilter for DCS-inspired constraint sequencing
        const smartFilter = new SmartFilter(cwd);
        await smartFilter.loadLearnedPatterns();

        // CONTEXT CARRYOVER: Legacy keyword-based session context (deprecated - use SessionManager instead)
        const session = await loadSessionContext(cwd);
        let contextFiles: string[] | undefined;
        let contextRelevance: { isRelated: boolean; reason: string; confidence: number } | null = null;

        // If we have a previous request, check if new request is related
        if (session.lastRequest) {
            // Quick keyword overlap check - skip expensive LLM call if >70% overlap
            const prevKeywords = new Set(session.lastRequest.keywords.map(k => k.toLowerCase()));
            const currKeywords = intentAnalysis.keywords.map(k => k.toLowerCase());
            const overlapCount = currKeywords.filter(k => prevKeywords.has(k)).length;
            const overlapPercent = currKeywords.length > 0 ? overlapCount / currKeywords.length : 0;

            if (overlapPercent > 0.7) {
                // High keyword overlap - assume related without API call
                contextFiles = session.lastRequest.topFiles;
                contextRelevance = {
                    isRelated: true,
                    reason: 'Similar keywords detected',
                    confidence: 0.8 + (overlapPercent - 0.7) * 0.5 // 0.8-0.95 confidence
                };
                progress(`Context: Similar keywords (${Math.round(overlapPercent * 100)}% overlap)`);
            }
            // NOTE: Old LLM-based context relevance removed - now using SessionManager with deterministic boosts
        }

        const scoredFiles = await smartFilter.search(
            files,
            intentAnalysis.keywords,
            cache,
            cwd,
            contextFiles // Pass context files for boost!
        );

        // Get top files, prioritizing imports/exports
        // CRITICAL: If context was applied with VERY high confidence (>75%), ONLY show context files
        // User clearly wants to continue in the same area, not expand to other files
        if (contextFiles && contextFiles.length > 0 && contextRelevance && contextRelevance.confidence > 0.75) {
            // High confidence follow-up: filter to ONLY context files
            files = scoredFiles
                .filter(f => f.score > 0 && contextFiles.includes(f.path))
                .map(f => f.path);

            progress(`Focused on ${files.length} file(s) from previous context`);
        } else {
            // No context or lower confidence: include other matches too
            files = scoredFiles
                .filter(f => f.score > 0)
                .map(f => f.path);
        }

        // Extract file locations with line numbers for the top results
        const fileLocations = scoredFiles
            .filter(f => f.score > 0 && f.matchedLines && f.matchedLines.length > 0)
            .slice(0, 10) // Top 10 files with exact locations
            .map(f => ({
                path: f.path,
                lines: f.matchedLines
            }));

        // Report interesting findings with better context
        const topFile = scoredFiles[0];
        if (topFile && topFile.score > 20) {
            const matchInfo = topFile.matchedConstraints.slice(0, 2).join(', ');
            if (topFile.matchedLines && topFile.matchedLines.length > 0) {
                const firstMatch = topFile.matchedLines[0];
                // Show the line with keyword highlighted for debugging
                const preview = firstMatch.content.length > 80
                    ? firstMatch.content.substring(0, 80) + '...'
                    : firstMatch.content;
                progress(`Found: ${path.basename(topFile.path)}:${firstMatch.line} - "${preview}"`);

                // If we found multiple matches, show them too
                if (topFile.matchedLines.length > 1) {
                    topFile.matchedLines.slice(1, 3).forEach(match => {
                        const preview = match.content.substring(0, 60) + '...';
                        progress(`  Also: Line ${match.line} - "${preview}"`);
                    });
                }
            } else {
                progress(`Found relevant file: ${path.basename(topFile.path)} (${matchInfo})`);
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const maxFiles = getMaxFiles();
        const finalCount = files.slice(0, maxFiles).length;
        progress(`Scan complete (${finalCount} files in ${elapsed}s)`);

        // SAVE SESSION CONTEXT for next request
        const topFilesForContext = scoredFiles
            .slice(0, 5) // Top 5 files
            .filter(f => f.score > 20) // Only meaningful matches
            .map(f => f.path);

        if (topFilesForContext.length > 0) {
            await saveSessionContext(cwd, {
                lastRequest: {
                    prompt: intentAnalysis.keywords.join(' '),
                    keywords: intentAnalysis.keywords,
                    topFiles: topFilesForContext,
                    timestamp: Date.now()
                }
            });
        }

        // Return ProjectContext with filtered files, metadata, and exact locations!
        return {
            techStack: cache.techStack,
            fileStructure: files.slice(0, maxFiles),
            scoredFiles: scoredFiles.slice(0, maxFiles).map(sf => ({
                path: sf.path,
                score: sf.score,
                reasons: sf.matchedConstraints
            })),
            openFiles: [],
            metadata: cache.metadata,
            fileLocations, // ← THE GOLD: Exact line numbers!
            gitState // NEW
        };
    }

    // Low confidence or general query - use brain scorer directly
    const keywords = intentAnalysis?.keywords || [];
    const brainScorer = new ManticEngine();
    const scoredFiles = await brainScorer.rankFiles(
        files,
        keywords,
        intentAnalysis || { category: 'general', confidence: 0, keywords: [], matchedPatterns: [] },
        cwd
    );

    files = scoredFiles
        .filter(f => f.score > 0)
        .map(f => f.path);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const maxFiles = getMaxFiles();
    const finalCount = files.slice(0, maxFiles).length;
    progress(`Scan complete (${finalCount} files in ${elapsed}s)`);

    // Return ProjectContext with brain scorer results
    return {
        techStack: cache.techStack,
        fileStructure: files.slice(0, maxFiles),
        scoredFiles: scoredFiles.slice(0, maxFiles).map(sf => ({
            path: sf.path,
            score: sf.score,
            reasons: sf.reasons
        })),
        openFiles: [],
        metadata: cache.metadata,
        gitState
    };
}

/**
 * Legacy scan without caching (original implementation)
 * Used when caching is disabled or semantic parsing not needed
 * This is the internal implementation - use scanProjectLegacy() for timeout support.
 *
 * NOW WITH BRAIN-INSPIRED SCORING - achieves 0.3s on monorepos!
 */
async function scanProjectLegacyInternal(
    cwd: string,
    intentAnalysis?: IntentAnalysis,
    onProgress?: (msg: string) => void,
    sessionBoosts?: Array<{ path: string; boostFactor: number; reason: string }>,
    skipScoring = false
): Promise<ProjectContext> {
    const startTime = Date.now();

    const progress = (msg: string) => {
        if (onProgress) onProgress(msg);
    };

    // 1. Get File Structure
    // 1. Get File Structure using Native Loader
    const loader = new NativeLoader(getIgnorePatterns());
    let files = await loader.loadFiles(cwd);

    progress(`Scanned ${files.length.toLocaleString()} files using NativeLoader`);

    // Analyze directory structure (Disabled for performance test)
    // const dirStats = analyzeDirectoryStructure(files);
    const dirStats = new Map<string, number>();
    progress('Skipped directory analysis');

    progress(`Found ${files.length.toLocaleString()} files total`);

    // 2. Detect Tech Stack
    const techStack = await detectTechStack(cwd);

    // 3. BRAIN-INSPIRED SCORING (if intent provided)
    let limitedFiles = files;
    let scoredFilesWithScores: FileScore[] | undefined;

    if (intentAnalysis && intentAnalysis.confidence > 0.5) {
        // High confidence - use brain scorer with intent
        const keywords = intentAnalysis.keywords || [];

        if (keywords.length > 0 && !skipScoring) {
            progress('Applying brain-inspired scoring (high confidence)...');
            const brainScorer = new ManticEngine();
            const scoredFiles = await brainScorer.rankFiles(
                files,
                keywords,
                intentAnalysis,
                cwd
            );
            scoredFilesWithScores = scoredFiles;
            limitedFiles = scoredFiles.map(f => f.path);
            progress(`Brain scoring: ${files.length} → ${scoredFiles.length} files`);
        } else {
            // No keywords - just take first 300 files
            limitedFiles = files.slice(0, getMaxFiles());
            progress(`Using first 300 files (no keywords provided)`);
        }
    } else {
        // Low confidence or no intent - use brain scorer with available keywords
        const keywords = intentAnalysis?.keywords || [];

        if (keywords.length > 0 && intentAnalysis && !skipScoring) {
            progress('Applying brain-inspired scoring...');
            const brainScorer = new ManticEngine();
            const scoredFiles = await brainScorer.rankFiles(
                files,
                keywords,
                intentAnalysis,
                cwd
            );
            scoredFilesWithScores = scoredFiles;
            limitedFiles = scoredFiles.map(f => f.path);
            progress(`Brain scoring: ${files.length} → ${scoredFiles.length} files`);
        } else {
            // No keywords at all - just take first 300 files (unless skipScoring is set, then take all)
            if (skipScoring) {
                limitedFiles = files;
                progress(`Passing ${files.length} files to processRequest (skipScoring=true)`);
            } else {
                limitedFiles = files.slice(0, getMaxFiles());
                progress(`Using first 300 files (no keywords provided)`);
            }
        }
    }

    // ...

    // PROGRESSIVE DISCLOSURE: Enrich scoredFiles with metadata
    if (scoredFilesWithScores && scoredFilesWithScores.length > 0) {
        progress('Enriching results with metadata...');

        // Get file metadata in parallel (only for top results)
        const topFiles = scoredFilesWithScores.slice(0, 100);
        const metadataMap = await getFileMetadataBatch(
            topFiles.map(f => f.path),
            cwd
        );

        // Calculate confidence scores
        const allScores = scoredFilesWithScores.map(f => f.score);

        // Enrich each file with metadata
        scoredFilesWithScores = scoredFilesWithScores.map(fileScore => {
            const fileMeta = metadataMap.get(fileScore.path);
            const confidence = calculateConfidence(fileScore.score, allScores);

            return {
                ...fileScore,
                metadata: fileMeta ? {
                    sizeBytes: fileMeta.sizeBytes,
                    lines: fileMeta.lines,
                    estimatedTokens: fileMeta.estimatedTokens,
                    lastModified: fileMeta.lastModified,
                    created: fileMeta.created,
                    confidence
                } : {
                    confidence  // At least include confidence even if metadata fails
                }
            };
        });
    }

    // Classify project type
    const projectMetadata = classifyProject(files, techStack);

    return {
        techStack,
        fileStructure: limitedFiles,
        scoredFiles: scoredFilesWithScores?.slice(0, getMaxFiles()), // Limit to max files
        openFiles: [],
        metadata: projectMetadata
    };
}

/**
 * Detects the project's tech stack from dependency manifests.
 * Checks package.json for JS/TS projects and composer.json for PHP projects.
 * @param cwd - The working directory to search for manifest files
 * @returns A comma-separated string of significant dependencies, or "Unknown"
 */
async function detectTechStack(cwd: string): Promise<string> {
    // Try package.json first (JavaScript/TypeScript projects)
    try {
        const packageJsonPath = path.join(cwd, 'package.json');
        const packageJsonRaw = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonRaw);

        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        const significantDeps = filterSignificantDeps(Object.keys(deps), 'js');

        if (significantDeps.length > 0) {
            return significantDeps.join(', ');
        }
    } catch (error) {
        // Package.json doesn't exist or can't be read
    }

    // Try composer.json (PHP projects)
    try {
        const composerJsonPath = path.join(cwd, 'composer.json');
        const composerJsonRaw = await fs.readFile(composerJsonPath, 'utf-8');
        const composerJson = JSON.parse(composerJsonRaw);

        const deps = { ...composerJson.require, ...composerJson['require-dev'] };
        const significantDeps = filterSignificantDeps(Object.keys(deps), 'php');

        if (significantDeps.length > 0) {
            return significantDeps.join(', ');
        }
    } catch (error) {
        // composer.json doesn't exist or can't be read
    }

    return "Unknown";
}

/**
 * Filters dependencies to extract only significant/core technologies.
 * Removes utility packages and keeps frameworks, ORMs, and major libraries.
 * @param deps - Array of dependency names to filter
 * @param ecosystem - The package ecosystem ('js' for npm, 'php' for composer)
 * @returns Array of significant dependency names
 */
function filterSignificantDeps(deps: string[], ecosystem: 'js' | 'php'): string[] {
    const JS_CORE_TECHS = [
        'react', 'next', 'vue', 'nuxt', 'svelte', 'angular',
        'tailwindcss', 'typescript', 'node', 'express', 'nest',
        'supabase', 'firebase', 'prisma', 'graphql', 'apollo',
        'framer-motion', 'redux', 'zustand', 'zod', 'radix',
        'tanstack', 'lucide', 'shadcn'
    ];

    const PHP_CORE_TECHS = [
        'laravel', 'symfony', 'flightphp', 'slim', 'laminas', 'codeigniter',
        'redbean', 'gabordemooij/redbean', 'doctrine', 'eloquent', 'propel',
        'twig', 'blade', 'smarty', 'latte',
        'phpunit', 'pest', 'codeception',
        'monolog', 'guzzle', 'carbon', 'nesbot/carbon',
        'league', 'spatie', 'intervention',
        'livewire', 'inertia', 'filament',
        'wordpress', 'drupal', 'magento', 'prestashop'
    ];

    const coreTechs = ecosystem === 'php' ? PHP_CORE_TECHS : JS_CORE_TECHS;

    return deps.filter(d =>
        coreTechs.some(tech => d.toLowerCase().includes(tech.toLowerCase()))
    );
}

/**
 * Format dependencies for display - truncate gracefully and group by namespace
 */
function formatDependencies(deps: string[]): string {
    const MAX_DISPLAY = 7; // Show top 7 dependencies

    if (deps.length === 0) {
        return 'Unknown';
    }

    // Group by namespace (e.g., @radix-ui/*, @tanstack/*)
    const namespaced = new Map<string, string[]>();
    const regular: string[] = [];

    for (const dep of deps) {
        if (dep.startsWith('@')) {
            const namespace = dep.split('/')[0];
            if (!namespaced.has(namespace)) {
                namespaced.set(namespace, []);
            }
            namespaced.get(namespace)!.push(dep);
        } else {
            regular.push(dep);
        }
    }

    // Format namespaced dependencies
    const namespacedFormatted: string[] = [];
    for (const [namespace, packages] of namespaced.entries()) {
        if (packages.length > 2) {
            // Group if more than 2 packages
            namespacedFormatted.push(`${namespace}/*`);
        } else {
            // Show individually if only 1-2 packages
            namespacedFormatted.push(...packages);
        }
    }

    // Combine and capitalize
    const allFormatted = [...regular, ...namespacedFormatted].map(dep => {
        // Capitalize first letter
        const name = dep.replace('@', '').replace(/[-/]/g, ' ');
        return name.split(' ').map(word =>
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
    });

    // Truncate if too many
    if (allFormatted.length > MAX_DISPLAY) {
        const shown = allFormatted.slice(0, MAX_DISPLAY);
        const remaining = allFormatted.length - MAX_DISPLAY;
        return `${shown.join(', ')} + ${remaining} more`;
    }

    return allFormatted.join(', ');
}

/**
 * Filter files based on intent analysis
 */
async function filterFilesByIntent(
    allFiles: string[],
    intent: IntentAnalysis,
    cache: CacheIndex | null
): Promise<string[]> {
    // 1. Get path patterns for intent category
    const pathPatterns = INTENT_TO_PATHS[intent.category] || [];

    // 2. Get keyword matches for intent category
    const targetKeywords = INTENT_TO_KEYWORDS[intent.category] || [];

    // 3. Score each file
    const scoredFiles = allFiles.map(filePath => {
        let score = 0;

        // Path pattern matching (highest weight)
        if (matchesAnyPattern(filePath, pathPatterns)) {
            score += 10;
        }

        // Keyword matching from cache
        if (cache?.files[filePath]) {
            const fileKeywords = cache.files[filePath].keywords || [];
            const overlap = intersection(fileKeywords, targetKeywords);
            score += overlap.length * 5; // 5 points per matching keyword
        }

        // Filename keyword matching
        const lowerPath = filePath.toLowerCase();
        for (const keyword of intent.keywords) {
            if (lowerPath.includes(keyword.toLowerCase())) {
                score += 3;
            }
        }

        return { path: filePath, score };
    });

    // 4. Sort by score and take top N
    const filtered = scoredFiles
        .filter(f => f.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50) // Default limit: 50 files
        .map(f => f.path);

    // 5. Always include critical config files if they exist
    const configFiles = ['package.json', 'tsconfig.json', 'tailwind.config.js', 'tailwind.config.ts'];
    for (const config of configFiles) {
        if (allFiles.includes(config) && !filtered.includes(config)) {
            filtered.push(config);
        }
    }

    return filtered;
}

/**
 * Check if a file path matches any of the given patterns
 * Simple glob matching: supports *, **, and literal paths
 */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
        // Convert glob pattern to regex
        // Use placeholders to protect glob patterns from dot escaping
        let regexPattern = pattern
            .replace(/\*\*\//g, '___GLOBSTARSLASH___')
            .replace(/\*\*/g, '___GLOBSTAR___')
            .replace(/\*/g, '___STAR___')
            .replace(/\?/g, '___QUESTION___');

        // Now escape dots in the actual path parts
        regexPattern = regexPattern.replace(/\./g, '\\.');

        // Replace placeholders with regex equivalents
        regexPattern = regexPattern
            .replace(/___GLOBSTARSLASH___/g, '(?:.*/)?') // **/ matches optional directory prefix
            .replace(/___GLOBSTAR___/g, '.*')             // ** matches any path
            .replace(/___STAR___/g, '[^/]*')              // * matches anything except /
            .replace(/___QUESTION___/g, '.');             // ? matches single char

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(filePath);
    });
}

/**
 * Find intersection of two arrays
 */
function intersection<T>(arr1: T[], arr2: T[]): T[] {
    const set2 = new Set(arr2);
    return arr1.filter(item => set2.has(item));
}

/**
 * Analyze directory structure to show meaningful groups
 */
function analyzeDirectoryStructure(files: string[]): Map<string, number> {
    const dirCounts = new Map<string, number>();

    // Priority directories to report
    const priorityDirs = ['components', 'lib', 'api', 'pages', 'app', 'src', 'styles', 'utils', 'hooks'];

    for (const file of files) {
        const parts = file.split('/');

        // Find the first meaningful directory
        for (const dir of priorityDirs) {
            if (parts.includes(dir)) {
                dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
                break;
            }
        }
    }

    // Sort by count descending, limit to top 3
    return new Map(
        Array.from(dirCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
    );
}

/**
 * Report interesting findings based on intent and filtered files
 */
function reportIntentFindings(
    filteredFiles: string[],
    intent: IntentAnalysis,
    _cache: CacheIndex | null
): string | null {
    const keywords = intent.keywords;

    // Look for files matching key intent keywords
    const matches: string[] = [];

    for (const keyword of keywords.slice(0, 3)) { // Check top 3 keywords
        const matchingFiles = filteredFiles.filter(file => {
            const fileName = file.toLowerCase();
            return fileName.includes(keyword.toLowerCase());
        });

        if (matchingFiles.length > 0) {
            matches.push(`${matchingFiles.length} ${keyword} file${matchingFiles.length > 1 ? 's' : ''}`);
        }
    }

    if (matches.length > 0) {
        return `Found ${matches.join(', ')} ✓`;
    }

    return null;
}

/**
 * Public wrapper for scanProject with timeout support
 */
export async function scanProject(
    cwd: string = process.cwd(),
    options: ScanOptions = {}
): Promise<ProjectContext> {
    const timeout = getTimeout();

    const timeoutPromise = new Promise<ProjectContext>((_, reject) => {
        setTimeout(() => reject(new Error(`Scan timeout after ${timeout}ms`)), timeout);
    });

    try {
        return await Promise.race([
            scanProjectInternal(cwd, options),
            timeoutPromise
        ]);
    } catch (error) {
        if (error instanceof Error && error.message.includes('timeout')) {
            // Return empty result on timeout
            return {
                techStack: 'Unknown',
                fileStructure: [],
                scoredFiles: [],
                openFiles: []
            };
        }
        throw error;
    }
}

/**
 * Public wrapper for scanProjectLegacy with timeout support
 */
async function scanProjectLegacy(
    cwd: string,
    intentAnalysis?: IntentAnalysis,
    onProgress?: (msg: string) => void,
    sessionBoosts?: Array<{ path: string; boostFactor: number; reason: string }>
): Promise<ProjectContext> {
    const timeout = getTimeout();

    const timeoutPromise = new Promise<ProjectContext>((_, reject) => {
        setTimeout(() => reject(new Error(`Scan timeout after ${timeout}ms`)), timeout);
    });

    try {
        return await Promise.race([
            scanProjectLegacyInternal(cwd, intentAnalysis, onProgress, sessionBoosts),
            timeoutPromise
        ]);
    } catch (error) {
        if (error instanceof Error && error.message.includes('timeout')) {
            // Return empty result on timeout
            return {
                techStack: 'Unknown',
                fileStructure: [],
                scoredFiles: [],
                openFiles: []
            };
        }
        throw error;
    }
}
