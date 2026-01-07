import { ProjectType, ProjectMetadata } from './types.js';

/**
 * Classify project type based on file structure and tech stack
 * Uses pattern matching for fast, deterministic classification
 */
export function classifyProject(files: string[], techStack: string): ProjectMetadata {
    const fileLower = files.map(f => f.toLowerCase());
    const techStackLower = (techStack || '').toLowerCase();

    // Detect project type based on files and tech stack
    let projectType: ProjectType = 'unknown';

    // Next.js detection
    if (fileLower.some(f => f.includes('next.config')) ||
        fileLower.some(f => f.includes('app/layout')) ||
        fileLower.some(f => f.includes('pages/_app'))) {
        projectType = 'nextjs';
    }
    // React SPA detection
    else if (techStackLower.includes('react') &&
             fileLower.some(f => f.includes('src/app') || f.includes('src/index'))) {
        projectType = 'react-spa';
    }
    // Vue detection
    else if (techStackLower.includes('vue') ||
             fileLower.some(f => f.endsWith('.vue'))) {
        projectType = 'vue';
    }
    // PHP detection (Laravel, Symfony, FlightPHP, WordPress, etc.)
    // Must come early since PHP projects may have cli/, routes/, controllers/ folders
    else if (techStackLower.includes('laravel') ||
             techStackLower.includes('symfony') ||
             techStackLower.includes('flightphp') ||
             techStackLower.includes('slim') ||
             techStackLower.includes('laminas') ||
             techStackLower.includes('codeigniter') ||
             techStackLower.includes('wordpress') ||
             techStackLower.includes('drupal') ||
             techStackLower.includes('redbean') ||
             techStackLower.includes('phpunit') ||
             fileLower.some(f => f.includes('composer.json'))) {
        projectType = 'php';
    }
    // CLI detection (JS/TS)
    else if (fileLower.some(f => f.includes('bin/') || f.includes('cli.')) ||
             techStackLower.includes('commander') ||
             techStackLower.includes('yargs')) {
        projectType = 'cli';
    }
    // Backend API detection (JS/TS)
    else if (fileLower.some(f => f.includes('routes/') || f.includes('api/') || f.includes('controllers/')) ||
             techStackLower.includes('express') ||
             techStackLower.includes('fastify')) {
        projectType = 'backend-api';
    }
    // Python detection
    else if (fileLower.some(f => f.endsWith('.py')) ||
             fileLower.some(f => f.includes('requirements.txt'))) {
        projectType = 'python';
    }
    // Go detection
    else if (fileLower.some(f => f.includes('go.mod')) ||
             fileLower.some(f => f.endsWith('.go'))) {
        projectType = 'go';
    }
    // Rust detection
    else if (fileLower.some(f => f.includes('cargo.toml')) ||
             fileLower.some(f => f.endsWith('.rs'))) {
        projectType = 'rust';
    }
    // Library detection
    else if (fileLower.some(f => f.includes('lib/') && !f.includes('node_modules')) ||
             (techStack && !fileLower.some(f => f.includes('src/app') || f.includes('pages/')))) {
        projectType = 'library';
    }

    // Detect capabilities
    const hasUI = fileLower.some(f =>
        f.includes('component') ||
        f.includes('app/') ||
        f.includes('pages/') ||
        f.includes('views/') ||
        f.includes('.css') ||
        f.includes('.scss') ||
        f.endsWith('.vue') ||
        f.endsWith('.jsx') ||
        f.endsWith('.tsx')
    );

    const hasBackend = fileLower.some(f =>
        f.includes('api/') ||
        f.includes('routes/') ||
        f.includes('controllers/') ||
        f.includes('server.') ||
        f.includes('backend/')
    );

    const hasTesting = fileLower.some(f =>
        f.includes('test') ||
        f.includes('spec') ||
        f.includes('__tests__')
    );

    const isCLI = projectType === 'cli' ||
                  fileLower.some(f => f.includes('bin/')) ||
                  techStack.toLowerCase().includes('commander') ||
                  techStack.toLowerCase().includes('yargs');

    return {
        projectType,
        hasUI,
        hasBackend,
        hasTesting,
        isCLI
    };
}

export function getProjectTypeDescription(metadata: ProjectMetadata): string {
    const { projectType, isCLI, hasUI, hasBackend } = metadata;

    const descriptions: Record<ProjectType, string> = {
        'nextjs': 'Next.js web application',
        'react-spa': 'React single-page application',
        'vue': 'Vue.js application',
        'cli': 'Command-line tool',
        'backend-api': 'Backend API server',
        'library': 'JavaScript/TypeScript library',
        'python': 'Python project',
        'go': 'Go project',
        'rust': 'Rust project',
        'php': 'PHP project',
        'unknown': 'Unknown project type'
    };

    let desc = descriptions[projectType];

    // Add capabilities
    const capabilities: string[] = [];
    if (hasUI) capabilities.push('UI');
    if (hasBackend) capabilities.push('API');
    if (isCLI) capabilities.push('CLI');

    if (capabilities.length > 0) {
        desc += ` (${capabilities.join(', ')})`;
    }

    return desc;
}
