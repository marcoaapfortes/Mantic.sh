import type * as ts from 'typescript';
import {
    ExportInfo,
    ImportInfo,
    ComponentInfo,
    FunctionInfo,
    FileEntry,
} from './types.js';

// Global variable to hold the loaded TypeScript module
let tsModule: typeof ts;

// Global variable for PHP parser (lazy loaded)
let phpParser: any;

/**
 * Lazily loads the TypeScript compiler module.
 * Tries to load from the user's project first, then falls back to dev dependency.
 * @throws Error if TypeScript is not found in either location
 */
function loadTypeScript() {
    if (tsModule) return;
    try {
        // Try to load from the user's project first (where the command is run)
        const userTsPath = require.resolve('typescript', { paths: [process.cwd()] });
        tsModule = require(userTsPath);
    } catch (e) {
        try {
            // Fallback to our (dev) dependency or global
            tsModule = require('typescript');
        } catch (e2) {
            throw new Error('TypeScript not found. Please install typescript in your project: npm install -D typescript');
        }
    }
}

/**
 * Lazily loads the PHP parser module (php-parser).
 * Initializes the parser with PHP 7+ syntax support and error suppression.
 * @throws Error if php-parser is not installed
 */
function loadPHPParser() {
    if (phpParser) return;
    try {
        const Engine = require('php-parser');
        phpParser = new Engine({
            parser: {
                extractDoc: true,
                php7: true,
                suppressErrors: true,
            },
            ast: {
                withPositions: true,
                withSource: false,
            },
        });
    } catch (e) {
        throw new Error('php-parser not found. Please install: npm install php-parser');
    }
}

// Keyword patterns for semantic search
const KEYWORD_PATTERNS = [
    /button/i, /modal/i, /dialog/i, /form/i, /input/i,
    /header/i, /footer/i, /nav/i, /menu/i, /sidebar/i,
    /theme/i, /dark/i, /light/i, /color/i, /style/i,
    /auth/i, /login/i, /signup/i, /user/i, /profile/i,
    /api/i, /fetch/i, /query/i, /mutation/i,
    /loading/i, /error/i, /success/i, /state/i,
    /card/i, /list/i, /table/i, /grid/i, /layout/i,
    /dropdown/i, /select/i, /checkbox/i, /radio/i, /switch/i,
];

export interface ParsedFileData {
    exports: ExportInfo[];
    imports: ImportInfo[];
    components: ComponentInfo[];
    keywords: string[];
    functions: FunctionInfo[];
    classes: string[];
    types: string[];
    language: 'typescript' | 'javascript' | 'tsx' | 'jsx' | 'php';
}

export class FileParser {
    /**
     * Parse a source file and extract semantic information
     */
    parse(filePath: string, content: string): ParsedFileData {
        // Handle PHP files separately
        if (filePath.endsWith('.php')) {
            return this.parsePHP(filePath, content);
        }

        loadTypeScript();

        const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
        const isTypeScript = filePath.endsWith('.ts') || filePath.endsWith('.tsx');

        const language: ParsedFileData['language'] =
            filePath.endsWith('.tsx') ? 'tsx' :
                filePath.endsWith('.ts') ? 'typescript' :
                    filePath.endsWith('.jsx') ? 'jsx' : 'javascript';

        const sourceFile = tsModule.createSourceFile(
            filePath,
            content,
            tsModule.ScriptTarget.Latest,
            true,
            isTsx ? tsModule.ScriptKind.TSX : isTypeScript ? tsModule.ScriptKind.TS : tsModule.ScriptKind.JS
        );

        const result: ParsedFileData = {
            exports: [],
            imports: [],
            components: [],
            keywords: [],
            functions: [],
            classes: [],
            types: [],
            language,
        };

        const keywordSet = new Set<string>();

        // Visitor pattern to traverse AST
        const visit = (node: ts.Node) => {
            // Extract exports
            if (tsModule.isExportDeclaration(node)) {
                this.extractExportDeclaration(node, result);
            } else if (tsModule.isExportAssignment(node)) {
                this.extractExportAssignment(node, result);
            }

            // Check for exported declarations
            const hasExportModifier = tsModule.canHaveModifiers(node) &&
                tsModule.getModifiers(node)?.some((m: ts.Modifier) => m.kind === tsModule.SyntaxKind.ExportKeyword);

            if (hasExportModifier) {
                if (tsModule.isFunctionDeclaration(node) && node.name) {
                    result.exports.push({
                        name: node.name.text,
                        type: 'function',
                        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                    });
                } else if (tsModule.isClassDeclaration(node) && node.name) {
                    result.exports.push({
                        name: node.name.text,
                        type: 'class',
                        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                    });
                } else if (tsModule.isVariableStatement(node)) {
                    node.declarationList.declarations.forEach(decl => {
                        if (tsModule.isIdentifier(decl.name)) {
                            result.exports.push({
                                name: decl.name.text,
                                type: 'const',
                                line: sourceFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
                            });
                        }
                    });
                } else if (tsModule.isTypeAliasDeclaration(node) && node.name) {
                    result.exports.push({
                        name: node.name.text,
                        type: 'type',
                        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                    });
                } else if (tsModule.isInterfaceDeclaration(node) && node.name) {
                    result.exports.push({
                        name: node.name.text,
                        type: 'interface',
                        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                    });
                }
            }

            // Extract imports
            if (tsModule.isImportDeclaration(node)) {
                this.extractImportDeclaration(node, result);
            }

            // Extract React/Vue components
            if (isTsx && this.isComponentDeclaration(node)) {
                this.extractComponent(node, sourceFile, result);
            }

            // Extract functions
            if (tsModule.isFunctionDeclaration(node) && node.name) {
                const modifiers = tsModule.canHaveModifiers(node) ? tsModule.getModifiers(node) : undefined;
                const isExported = modifiers?.some((m: ts.Modifier) => m.kind === tsModule.SyntaxKind.ExportKeyword) || false;
                const isAsync = modifiers?.some((m: ts.Modifier) => m.kind === tsModule.SyntaxKind.AsyncKeyword) || false;
                result.functions.push({
                    name: node.name.text,
                    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                    isAsync,
                    isExported,
                });
            }

            // Extract classes
            if (tsModule.isClassDeclaration(node) && node.name) {
                result.classes.push(node.name.text);
            }

            // Extract types/interfaces
            if (tsModule.isTypeAliasDeclaration(node) && node.name) {
                result.types.push(node.name.text);
            } else if (tsModule.isInterfaceDeclaration(node) && node.name) {
                result.types.push(node.name.text);
            }

            // Extract semantic keywords
            this.extractKeywords(node, keywordSet);

            tsModule.forEachChild(node, visit);
        };

        visit(sourceFile);

        // Convert keyword set to sorted array
        result.keywords = Array.from(keywordSet).sort();

        return result;
    }

    /**
     * Extracts named exports from an export declaration node.
     * @param node - The TypeScript export declaration AST node
     * @param result - The parsed file data to populate
     */
    private extractExportDeclaration(node: ts.ExportDeclaration, result: ParsedFileData) {
        if (node.exportClause && tsModule.isNamedExports(node.exportClause)) {
            node.exportClause.elements.forEach(element => {
                result.exports.push({
                    name: element.name.text,
                    type: 'variable',
                });
            });
        }
    }

    /**
     * Extracts default export from an export assignment node.
     * @param node - The TypeScript export assignment AST node
     * @param result - The parsed file data to populate
     */
    private extractExportAssignment(node: ts.ExportAssignment, result: ParsedFileData) {
        result.exports.push({
            name: 'default',
            type: 'default',
        });
    }

    /**
     * Extracts import information from an import declaration node.
     * Handles default imports, named imports, and namespace imports.
     * @param node - The TypeScript import declaration AST node
     * @param result - The parsed file data to populate
     */
    private extractImportDeclaration(node: ts.ImportDeclaration, result: ParsedFileData) {
        const moduleSpecifier = node.moduleSpecifier;
        if (!tsModule.isStringLiteral(moduleSpecifier)) return;

        const source = moduleSpecifier.text;
        const names: string[] = [];
        let isDefault = false;

        if (node.importClause) {
            // Default import
            if (node.importClause.name) {
                names.push(node.importClause.name.text);
                isDefault = true;
            }

            // Named imports
            if (node.importClause.namedBindings) {
                if (tsModule.isNamedImports(node.importClause.namedBindings)) {
                    node.importClause.namedBindings.elements.forEach(element => {
                        names.push(element.name.text);
                    });
                } else if (tsModule.isNamespaceImport(node.importClause.namedBindings)) {
                    names.push(node.importClause.namedBindings.name.text);
                }
            }
        }

        result.imports.push({
            source,
            names,
            isDefault,
        });
    }

    /**
     * Determines if an AST node represents a React/Vue component declaration.
     * Checks for function components, arrow function components, and class components.
     * @param node - The TypeScript AST node to check
     * @returns True if the node represents a component declaration
     */
    private isComponentDeclaration(node: ts.Node): boolean {
        // Function component
        if (tsModule.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            return /^[A-Z]/.test(name); // Starts with capital letter
        }

        // Arrow function component
        if (tsModule.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (tsModule.isIdentifier(decl.name) && /^[A-Z]/.test(decl.name.text)) {
                    if (decl.initializer && (
                        tsModule.isArrowFunction(decl.initializer) ||
                        tsModule.isFunctionExpression(decl.initializer)
                    )) {
                        return true;
                    }
                }
            }
        }

        // Class component
        if (tsModule.isClassDeclaration(node) && node.name) {
            const name = node.name.text;
            if (/^[A-Z]/.test(name)) {
                // Check if it extends React.Component or Component
                if (node.heritageClauses) {
                    for (const clause of node.heritageClauses) {
                        for (const type of clause.types) {
                            const text = type.expression.getText();
                            if (text.includes('Component')) {
                                return true;
                            }
                        }
                    }
                }
                // Even without heritage clause, capital letter suggests component
                return true;
            }
        }

        return false;
    }

    /**
     * Extracts component information from a component declaration node.
     * @param node - The TypeScript AST node representing a component
     * @param sourceFile - The source file for line number calculation
     * @param result - The parsed file data to populate
     */
    private extractComponent(node: ts.Node, sourceFile: ts.SourceFile, result: ParsedFileData) {
        let name = '';
        let type: ComponentInfo['type'] = 'function';

        if (tsModule.isFunctionDeclaration(node) && node.name) {
            name = node.name.text;
            type = 'function';
        } else if (tsModule.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (tsModule.isIdentifier(decl.name)) {
                    name = decl.name.text;
                    if (decl.initializer && tsModule.isArrowFunction(decl.initializer)) {
                        type = 'arrow';
                    }
                }
            }
        } else if (tsModule.isClassDeclaration(node) && node.name) {
            name = node.name.text;
            type = 'class';
        }

        if (name) {
            result.components.push({
                name,
                type,
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            });
        }
    }

    /**
     * Extracts semantic keywords from AST nodes for search indexing.
     * Matches identifiers, string literals, and JSX elements against keyword patterns.
     * @param node - The TypeScript AST node to extract keywords from
     * @param keywordSet - The set to add extracted keywords to
     */
    private extractKeywords(node: ts.Node, keywordSet: Set<string>) {
        // Check identifiers
        if (tsModule.isIdentifier(node)) {
            const name = node.text;
            for (const pattern of KEYWORD_PATTERNS) {
                if (pattern.test(name)) {
                    keywordSet.add(name.toLowerCase());
                }
            }
        }

        // CRITICAL FIX: Extract JSX text content (e.g., <Button>Share</Button>)
        // This ensures button labels and other UI text get indexed
        if (tsModule.isJsxText(node)) {
            const text = node.text.trim();
            if (text.length > 0 && text.length < 30) { // Reasonable length for keywords
                // Extract individual words
                const words = text.split(/\s+/);
                words.forEach(word => {
                    const cleaned = word.replace(/[^a-zA-Z]/g, '').toLowerCase();
                    if (cleaned.length >= 3) { // Min 3 chars to avoid noise
                        keywordSet.add(cleaned);
                    }
                });
            }
        }

        // Check string literals
        if (tsModule.isStringLiteral(node)) {
            const text = node.text;
            for (const pattern of KEYWORD_PATTERNS) {
                if (pattern.test(text)) {
                    // Extract individual words from the string
                    const words = text.toLowerCase().split(/[^a-z]+/);
                    words.forEach(word => {
                        if (word && pattern.test(word)) {
                            keywordSet.add(word);
                        }
                    });
                }
            }
        }

        // Check JSX elements for component names and props
        if (tsModule.isJsxElement(node) || tsModule.isJsxSelfClosingElement(node)) {
            const tagName = tsModule.isJsxElement(node)
                ? node.openingElement.tagName.getText()
                : node.tagName.getText();

            for (const pattern of KEYWORD_PATTERNS) {
                if (pattern.test(tagName)) {
                    keywordSet.add(tagName.toLowerCase());
                }
            }
        }
    }

    /**
     * Parse PHP files using php-parser AST
     * Full AST-based extraction for accurate semantic analysis
     */
    private parsePHP(filePath: string, content: string): ParsedFileData {
        loadPHPParser();

        const result: ParsedFileData = {
            exports: [],
            imports: [],
            components: [],
            keywords: [],
            functions: [],
            classes: [],
            types: [],
            language: 'php',
        };

        const keywordSet = new Set<string>();

        try {
            const ast = phpParser.parseCode(content, filePath);

            // Helper to extract name from identifier node or string
            const getName = (nameNode: any): string | null => {
                if (!nameNode) return null;
                if (typeof nameNode === 'string') return nameNode;
                if (typeof nameNode === 'object' && nameNode.name) return nameNode.name;
                return null;
            };

            // Recursive AST walker
            const walk = (node: any) => {
                if (!node || typeof node !== 'object') return;

                switch (node.kind) {
                    case 'namespace':
                        if (node.name) {
                            keywordSet.add(node.name.toLowerCase());
                        }
                        break;

                    case 'class': {
                        const className = getName(node.name);
                        if (className) {
                            result.classes.push(className);
                            result.exports.push({
                                name: className,
                                type: 'class',
                                line: node.loc?.start?.line,
                            });
                            keywordSet.add(className.toLowerCase());
                        }
                        break;
                    }

                    case 'interface': {
                        const interfaceName = getName(node.name);
                        if (interfaceName) {
                            result.types.push(interfaceName);
                            result.exports.push({
                                name: interfaceName,
                                type: 'interface',
                                line: node.loc?.start?.line,
                            });
                            keywordSet.add(interfaceName.toLowerCase());
                        }
                        break;
                    }

                    case 'trait': {
                        const traitName = getName(node.name);
                        if (traitName) {
                            result.types.push(traitName);
                            keywordSet.add(traitName.toLowerCase());
                        }
                        break;
                    }

                    case 'function': {
                        const funcName = getName(node.name);
                        if (funcName) {
                            result.functions.push({
                                name: funcName,
                                line: node.loc?.start?.line,
                                isExported: true,
                            });
                            result.exports.push({
                                name: funcName,
                                type: 'function',
                                line: node.loc?.start?.line,
                            });
                            keywordSet.add(funcName.toLowerCase());
                        }
                        break;
                    }

                    case 'method': {
                        const methodName = getName(node.name);
                        if (methodName) {
                            // Skip magic methods for keyword extraction
                            if (!methodName.startsWith('__')) {
                                result.functions.push({
                                    name: methodName,
                                    line: node.loc?.start?.line,
                                    isExported: node.visibility === 'public',
                                });
                                keywordSet.add(methodName.toLowerCase());
                            }
                        }
                        break;
                    }

                    case 'usegroup': {
                        // Handle grouped use statements: use Foo\{Bar, Baz}
                        if (node.items && Array.isArray(node.items)) {
                            for (const item of node.items) {
                                const itemName = getName(item.name) || item.name;
                                if (itemName && typeof itemName === 'string') {
                                    const aliasName = getName(item.alias);
                                    const alias = aliasName || itemName.split('\\').pop() || itemName;
                                    result.imports.push({
                                        source: itemName,
                                        names: [alias],
                                        isDefault: false,
                                    });
                                }
                            }
                        }
                        break;
                    }

                    case 'useitem':
                        // Handle single use statement (skip if parent is usegroup)
                        // usegroup already handles its items
                        break;

                    case 'string':
                        // Extract keywords from string literals
                        if (node.value && typeof node.value === 'string') {
                            for (const pattern of KEYWORD_PATTERNS) {
                                if (pattern.test(node.value)) {
                                    const words = node.value.toLowerCase().split(/[^a-z]+/);
                                    words.forEach((word: string) => {
                                        if (word && word.length >= 3 && pattern.test(word)) {
                                            keywordSet.add(word);
                                        }
                                    });
                                }
                            }
                        }
                        break;

                    case 'identifier':
                        // Extract keywords from identifiers
                        if (node.name && typeof node.name === 'string') {
                            for (const pattern of KEYWORD_PATTERNS) {
                                if (pattern.test(node.name)) {
                                    keywordSet.add(node.name.toLowerCase());
                                }
                            }
                        }
                        break;
                }

                // Recursively walk child nodes
                for (const key of Object.keys(node)) {
                    const child = node[key];
                    if (Array.isArray(child)) {
                        child.forEach(walk);
                    } else if (child && typeof child === 'object') {
                        walk(child);
                    }
                }
            };

            walk(ast);
        } catch (error) {
            // If AST parsing fails, fall back to regex-based extraction
            return this.parsePHPFallback(filePath, content);
        }

        result.keywords = Array.from(keywordSet).sort();
        return result;
    }

    /**
     * Fallback regex-based PHP parsing when AST fails
     */
    private parsePHPFallback(filePath: string, content: string): ParsedFileData {
        const result: ParsedFileData = {
            exports: [],
            imports: [],
            components: [],
            keywords: [],
            functions: [],
            classes: [],
            types: [],
            language: 'php',
        };

        const keywordSet = new Set<string>();

        // Extract classes
        const classPattern = /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/gm;
        let classMatch;
        while ((classMatch = classPattern.exec(content)) !== null) {
            result.classes.push(classMatch[1]);
            result.exports.push({
                name: classMatch[1],
                type: 'class',
                line: content.substring(0, classMatch.index).split('\n').length,
            });
        }

        // Extract interfaces
        const interfacePattern = /^\s*interface\s+(\w+)/gm;
        let interfaceMatch;
        while ((interfaceMatch = interfacePattern.exec(content)) !== null) {
            result.types.push(interfaceMatch[1]);
        }

        // Extract functions
        const functionPattern = /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)\s*\(/gm;
        let funcMatch;
        while ((funcMatch = functionPattern.exec(content)) !== null) {
            const funcName = funcMatch[1];
            if (!funcName.startsWith('__')) {
                result.functions.push({
                    name: funcName,
                    line: content.substring(0, funcMatch.index).split('\n').length,
                    isExported: true,
                });
            }
        }

        // Extract use statements
        const usePattern = /^\s*use\s+([^;]+);/gm;
        let useMatch;
        while ((useMatch = usePattern.exec(content)) !== null) {
            const usePath = useMatch[1].trim();
            const parts = usePath.split(/\s+as\s+/i);
            const source = parts[0].trim();
            const alias = parts[1] ? parts[1].trim() : source.split('\\').pop() || source;
            result.imports.push({
                source: source,
                names: [alias],
                isDefault: false,
            });
        }

        // Extract keywords
        for (const pattern of KEYWORD_PATTERNS) {
            const matches = content.matchAll(new RegExp(`\\b(\\w*${pattern.source.replace(/[\/\\^$]/g, '')}\\w*)\\b`, 'gi'));
            for (const match of matches) {
                if (match[1] && match[1].length >= 3) {
                    keywordSet.add(match[1].toLowerCase());
                }
            }
        }

        result.keywords = Array.from(keywordSet).sort();
        return result;
    }
}

/**
 * Helper function to determine if a file should be parsed
 */
export function shouldParseFile(filePath: string): boolean {
    const ext = filePath.toLowerCase();
    return (
        (ext.endsWith('.ts') ||
            ext.endsWith('.tsx') ||
            ext.endsWith('.js') ||
            ext.endsWith('.jsx') ||
            ext.endsWith('.php')) &&
        !ext.includes('.test.') &&
        !ext.includes('.spec.') &&
        !ext.endsWith('.d.ts')
    );
}
