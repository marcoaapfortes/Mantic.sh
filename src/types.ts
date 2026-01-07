export interface FileScore {
    path: string;
    score: number;
    reasons: string[];
    // Progressive Disclosure Metadata (Phase 1)
    metadata?: {
        // Token economics
        sizeBytes?: number;
        lines?: number;
        estimatedTokens?: number;  // Rough estimate: lines * 4

        // Temporal signals
        lastModified?: string;  // ISO timestamp
        created?: string;  // ISO timestamp

        // Confidence signals
        confidence?: number;  // 0.0-1.0 based on score distribution

        // Structure hints (for Layer 2 - future)
        exports?: string[];  // Function/class names
        imports?: string[];  // Dependencies
    };
}

export interface ProjectContext {
    techStack: string; // e.g., "Next.js, Tailwind CSS, Supabase"
    fileStructure: string[]; // List of relevant file paths
    scoredFiles?: FileScore[]; // NEW: Files with their brain scorer scores (for --json mode)
    openFiles?: string[]; // Files currently open in the editor (optional context)
    metadata?: ProjectMetadata; // Project type classification
    fileLocations?: FileLocation[]; // NEW: Files with exact line numbers where keywords appear
    gitState?: string; // NEW: Output of git status for context
}

export interface UserRequest {
    originalPrompt: string; // The "vibe" prompt (e.g., "fix button")
    projectContext: ProjectContext;
}

export interface FileLocation {
    path: string;
    lines?: Array<{
        line: number;
        content: string;
        keyword: string;
    }>;
}

export interface EnhancedPrompt {
    summary: string; // Brief explanation of what the enhanced prompt targets
    finalPrompt: string; // The high-fidelity, context-aware prompt for the AI coder
    suggestedFiles?: string[]; // Files that the AI coder should be focusing on (legacy)
    fileLocations?: FileLocation[]; // NEW: Files with exact line numbers where keywords appear
    mismatch?: {
        detected: boolean;
        reason: string;
    };
}

// Cache-related types
export interface ExportInfo {
    name: string; // Export name (or 'default')
    type: 'function' | 'class' | 'const' | 'type' | 'interface' | 'default' | 'variable';
    line?: number; // Line number in source
}

export interface ImportInfo {
    source: string; // Import source (e.g., 'react', './Button')
    names: string[]; // Imported names
    isDefault?: boolean; // Default import?
    isDynamic?: boolean; // Dynamic import()?
}

export interface ComponentInfo {
    name: string; // Component name
    type: 'function' | 'class' | 'arrow';
    props?: string[]; // Prop names if detectable
    line?: number;
}

export interface FunctionInfo {
    name: string;
    line?: number;
    isAsync?: boolean;
    isExported?: boolean;
}

export interface FileEntry {
    path: string; // Relative path from project root
    mtime: number; // Last modification time (Unix timestamp)
    size: number; // File size in bytes
    hash?: string; // Optional: Quick hash for double-checking

    // Semantic data (only for parseable files)
    exports?: ExportInfo[]; // Named/default exports
    imports?: ImportInfo[]; // Import statements
    components?: ComponentInfo[]; // React/Vue components
    keywords?: string[]; // Extracted semantic keywords
    functions?: FunctionInfo[]; // Top-level functions
    classes?: string[]; // Class names
    types?: string[]; // Type/Interface names

    // Metadata
    language?: 'typescript' | 'javascript' | 'tsx' | 'jsx' | 'json' | 'php' | 'other';
    parseError?: string; // If AST parsing failed
    lastParsed?: number; // When semantic analysis was done
}

export type ProjectType =
    | 'nextjs'
    | 'react-spa'
    | 'vue'
    | 'cli'
    | 'backend-api'
    | 'library'
    | 'python'
    | 'go'
    | 'rust'
    | 'php'
    | 'unknown';

export interface ProjectMetadata {
    projectType: ProjectType;
    hasUI: boolean;          // Has UI components/pages
    hasBackend: boolean;     // Has API routes/endpoints
    hasTesting: boolean;     // Has test files
    isCLI: boolean;          // Is a command-line tool
}

export interface CacheIndex {
    version: string; // Cache format version (e.g., "1.0.0")
    lastScanTime: number; // Unix timestamp of last full scan
    projectRoot: string; // Absolute path to project root
    techStack: string; // Cached tech stack detection
    totalFiles: number; // Total number of indexed files
    files: Record<string, FileEntry>; // Keyed by relative file path
    metadata?: ProjectMetadata; // Project type classification
}

export interface ScanOptions {
    useCache?: boolean; // Default: true
    forceRefresh?: boolean; // Bypass cache
    parseSemantics?: boolean; // Default: true
    intentAnalysis?: IntentAnalysis; // Optional intent-based filtering
    onProgress?: (message: string) => void; // Progress callback
    sessionBoosts?: Array<{ path: string; boostFactor: number; reason: string }>; // Phase 2: Session memory
    skipScoring?: boolean; // Defer scoring to caller (e.g. for parallelization)
}

// Intent-based scanning types
export type IntentCategory =
    | 'UI'
    | 'auth'
    | 'styling'
    | 'performance'
    | 'backend'
    | 'testing'
    | 'config'
    | 'general'; // Fallback if no clear intent

export interface IntentAnalysis {
    category: IntentCategory;
    keywords: string[]; // Extracted from user prompt
    confidence: number; // 0.0 - 1.0
    matchedPatterns: string[]; // Patterns that matched
    originalPrompt?: string; // NEW: Original user prompt for context detection
    subCategory?: string; // NEW: Finer classification (e.g., "styling" for UI)
    entities?: { // NEW: Extracted specific entities
        files?: string[];
        functions?: string[];
        errors?: string[];
    };
}

// Session context for follow-up requests
export interface SessionContext {
    lastRequest?: {
        prompt: string;
        keywords: string[];
        topFiles: string[]; // Top 5 files from last search
        timestamp: number;
    };
}

// File type classification for filtering
export type FileType = 'code' | 'config' | 'test' | 'docs' | 'generated' | 'other';

// NEW: Raw context result (universal output format)
export interface ContextResult {
    query: string;
    intent: {
        category: IntentCategory;
        confidence: number;
        keywords: string[];
    };
    files: Array<{
        path: string;
        relevanceScore: number;
        matchReasons: string[]; // e.g., ["exports:Button", "keyword:auth"]
        fileType?: FileType; // NEW: For filtering and prioritization
        excerpts?: Array<{
            line: number;
            content: string;
            matchedKeyword: string;
        }>;
        // Progressive Disclosure Metadata (Phase 1)
        metadata?: {
            sizeBytes?: number;
            lines?: number;
            estimatedTokens?: number;
            lastModified?: string;
            created?: string;
            confidence?: number;
        };
        // Impact Analysis (Phase 2)
        impact?: {
            blastRadius: 'small' | 'medium' | 'large' | 'critical';
            score: number;
            directDependents: number;
            indirectDependents: number;
            relatedTests: number;
            warnings: string[];
        };
    }>;
    metadata: {
        projectType: string;
        techStack: string;
        totalScanned: number;
        filesReturned: number;
        timeMs: number;
        hasGitChanges: boolean;
    };
    gitState?: string;
    // Canonical file warnings (Phase 1 - Week 2-3)
    warnings?: Array<{
        type: 'duplicate_test' | 'duplicate_docs' | 'prefer_canonical' | 'file_not_found' | 'function_not_found' | 'class_not_found' | 'component_not_found';
        message: string;
        derivativeFile?: string;
        canonicalFile?: string;
        entity?: string;
        suggestions?: string[];
    }>;
    // Hallucination detection (Phase 1 - Week 4)
    validation?: {
        isValid: boolean;
        entityCount: number;
        foundCount: number;
    };
}
