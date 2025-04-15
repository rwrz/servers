#!/usr/bin/env node

// --- Part 1: Imports, Setup, Utilities, Schemas & Types ---

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {minimatch} from 'minimatch';
import {formatCode} from './formatters.js';
import {applyPatchToFile} from './patch-helpers.js'; // Keep for patch mode

// Imports for smart edit logic
import {exec} from 'child_process'; // For Git commands
import {promisify} from 'util';     // For Git commands
import {
    // Note: We are importing the OVERLOADED function signature correctly
    normalizeCodeForMatching,
    translateNormalizedRangeToOriginal,
    findFuzzyMatches,
    extractContextLines,
    detectLanguage,          // Make sure this isn't duplicated if already imported
    createUnifiedDiff,     // Keep for dry run diff output
    // Import Types/Interfaces needed
    NormalizationOptions,
    MappingEntry,
    NormalizationResult,
    // Import the legacy function with a different name if needed elsewhere,
    // but the main handler will use the new logic via applySmartEdits.
    // applyFileEdits as legacyApplyFileEdits
} from './edit-helpers.js';

const execAsync = promisify(exec); // Define promisified exec

// --- Command Line Argument Parsing & Directory Setup ---

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
    process.exit(1);
}

// Store allowed directories - global or passed around state is needed for validatePath
// Making it global here for simplicity based on original structure
let allowedDirectories: string[] = [];

// --- Utility Functions ---

// Normalize all paths consistently
function normalizePath(p: string): string {
    return path.normalize(p);
}

function expandHome(filepath: string): string {
    // Handle ~ at the start or as the only character
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

// Initialize allowed directories immediately after defining helpers
allowedDirectories = args.map(dir =>
    normalizePath(path.resolve(expandHome(dir)))
);

// Security utility: Validate path against allowed directories
async function validatePath(requestedPath: string): Promise<string> {
    const expandedPath = expandHome(requestedPath);
    // Resolve to absolute path robustly
    const absolute = path.resolve(expandedPath); // Resolves relative to CWD if not absolute

    const normalizedRequested = normalizePath(absolute);

    // Check if path is within allowed directories
    const isAllowed = allowedDirectories.some(dir => {
        // Check if it's the directory itself or within it
        return normalizedRequested === dir || normalizedRequested.startsWith(dir + path.sep);
    });

    if (!isAllowed) {
        throw new Error(`Access denied: Path "${requestedPath}" (resolved: "${normalizedRequested}") is not within allowed directories: ${allowedDirectories.join(', ')}`);
    }

    // Handle symlinks by checking their real path - crucial security step
    try {
        const realPath = await fs.realpath(normalizedRequested); // Use normalized absolute path here
        const normalizedReal = normalizePath(realPath);
        const isRealPathAllowed = allowedDirectories.some(dir => {
            return normalizedReal === dir || normalizedReal.startsWith(dir + path.sep);
        });
        if (!isRealPathAllowed) {
            throw new Error(`Access denied: Path "${requestedPath}" resolves to "${realPath}" which is outside allowed directories (symlink target check).`);
        }
        // Return the *resolved* real path for subsequent operations if it exists
        return realPath;
    } catch (error: any) {
        // If fs.realpath fails (e.g., file doesn't exist yet - common for write operations)
        if (error.code === 'ENOENT') {
            // For new files/dirs, verify the *intended parent directory* is allowed
            const parentDir = path.dirname(normalizedRequested);
            // Ensure parent isn't root or outside expected structure
            if (parentDir === normalizedRequested) {
                throw new Error(`Access denied: Cannot operate directly on root or invalid path structure: ${requestedPath}`);
            }

            try {
                const realParentPath = await fs.realpath(parentDir);
                const normalizedParent = normalizePath(realParentPath);
                const isParentAllowed = allowedDirectories.some(dir => {
                    return normalizedParent === dir || normalizedParent.startsWith(dir + path.sep);
                });
                if (!isParentAllowed) {
                    throw new Error(`Access denied: Parent directory "${parentDir}" (resolved: "${normalizedParent}") is outside allowed directories.`);
                }
                // If parent is allowed, return the original intended *normalized absolute path*
                // as the file doesn't exist yet for realpath to resolve fully.
                return normalizedRequested;
            } catch (parentError: any) {
                // If the parent directory itself doesn't exist
                if (parentError.code === 'ENOENT') {
                    // Allow if the non-existent parent is still *within* an allowed root
                    const isParentAllowedRootCheck = allowedDirectories.some(dir => {
                        return parentDir === dir || parentDir.startsWith(dir + path.sep);
                    });
                    if (!isParentAllowedRootCheck) {
                        throw new Error(`Access denied: Intended parent directory "${parentDir}" is outside allowed directories.`);
                    }
                    // Allow creation if parent structure is valid even if non-existent yet
                    return normalizedRequested;
                }
                throw new Error(`Error accessing parent directory "${parentDir}": ${parentError.message}`);
            }
        }
        // Re-throw other realpath errors (e.g., permission denied)
        throw error;
    }
}


// --- Schema Definitions ---

// Schemas for basic file operations
const ReadFileArgsSchema = z.object({
    path: z.string().min(1),
});

const ReadMultipleFilesArgsSchema = z.object({
    paths: z.array(z.string().min(1)).min(1),
});

const WriteFileArgsSchema = z.object({
    path: z.string().min(1),
    content: z.string(), // Allow empty content
});

// Schemas for the "smart" edit mode
const NormalizationOptionsSchema = z.object({
    ignoreComments: z.boolean().optional().default(true),
    ignoreLeadingWhitespace: z.boolean().optional().default(true),
    ignoreTrailingWhitespace: z.boolean().optional().default(true),
    ignoreInternalWhitespace: z.enum(['collapse', 'remove', 'keep']).optional().default('collapse'),
    ignoreBlankLines: z.boolean().optional().default(true),
    caseSensitive: z.boolean().optional().default(true),
}).strict().optional().default({}) // Use strict() and ensure default is an object
    .describe("Options for normalizing code before matching in 'smart' mode.");

const EditOperationSchema = z.object({
    oldText: z.string().min(1, "oldText cannot be empty"),
    newText: z.string(), // Allow empty newText for deletions
}).strict();

// The main schema for the enhanced edit_file tool
const EditFileArgsSchema = z.object({
    path: z.string().min(1).describe("Path to the file to edit."),
    mode: z.enum(["smart", "patch"]) // Simplified modes
        .optional()
        .default("smart")
        .describe("Editing mode: 'smart' (default, uses normalization/fuzzy matching/disambiguation) or 'patch' (apply unified diff)."),

    // --- Fields for 'smart' mode ---
    edits: z.array(EditOperationSchema)
        .optional()
        .describe("List of edit operations (REQUIRED for 'smart' mode)."),
    normalizationOptions: NormalizationOptionsSchema, // Use the defined schema with its default
    similarityThreshold: z.number().min(0).max(1).optional().default(1.0)
        .describe("Minimum similarity (0.0-1.0) for fuzzy matching (used in 'smart' mode). Default: 1.0."),
    disambiguationIndex: z.number().int().positive().optional()
        .describe("1-based index to select a match if a previous 'smart' edit call returned AMBIGUOUS status."),

    // --- Field for 'patch' mode ---
    patch: z.string()
        .optional()
        .describe("A unified diff patch string (REQUIRED for 'patch' mode)."),

    // --- Common Options ---
    dryRun: z.boolean().optional().default(false).describe("If true, preview changes without writing to disk. Default: false"),
    formatAfter: z.boolean().optional().default(false).describe("If true, format the code using a suitable formatter after applying edits/patch. Default: false"),
    // Note: 'includeContext' is no longer needed as an input parameter for smart mode
}).strict().superRefine((data, ctx) => { // Use strict() and refine for mode consistency
    if (data.mode === 'patch') {
        if (!data.patch) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Input 'patch' is required when mode is 'patch'.",
                path: ["patch"]
            });
        }
        // Disallow smart-mode fields in patch mode
        if (data.edits) ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Input 'edits' should not be provided when mode is 'patch'.",
            path: ["edits"]
        });
        // Check if normalizationOptions is different from its default empty object
        if (data.normalizationOptions && Object.keys(data.normalizationOptions).length > 0) ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Input 'normalizationOptions' should not be provided when mode is 'patch'.",
            path: ["normalizationOptions"]
        });
        if (data.similarityThreshold !== 1.0) ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Input 'similarityThreshold' should not be provided when mode is 'patch'.",
            path: ["similarityThreshold"]
        });
        if (data.disambiguationIndex) ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Input 'disambiguationIndex' should not be provided when mode is 'patch'.",
            path: ["disambiguationIndex"]
        });
    } else if (data.mode === 'smart') {
        if (!data.edits || data.edits.length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Input 'edits' is required and cannot be empty when mode is 'smart'.",
                path: ["edits"]
            });
        }
        // Disallow patch-mode fields in smart mode
        if (data.patch) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Input 'patch' should not be provided when mode is 'smart'.",
                path: ["patch"]
            });
        }
    }
});

// Schemas for directory and metadata operations
const CreateDirectoryArgsSchema = z.object({
    path: z.string().min(1),
});

const ListDirectoryArgsSchema = z.object({
    path: z.string().min(1),
});

const DirectoryTreeArgsSchema = z.object({
    path: z.string().min(1),
});

const MoveFileArgsSchema = z.object({
    source: z.string().min(1),
    destination: z.string().min(1),
});

const SearchFilesArgsSchema = z.object({
    path: z.string().min(1).describe("Starting directory for the search."),
    pattern: z.string().min(1).describe("Search pattern (case-insensitive substring matching)."),
    excludePatterns: z.array(z.string()).optional().default([])
        .describe("Glob patterns for paths/files/directories to exclude."),
});

const GetFileInfoArgsSchema = z.object({
    path: z.string().min(1),
});

// --- Type Definitions ---

// Infer TypeScript types from Zod schemas for type safety
type EditFileInput = z.infer<typeof EditFileArgsSchema>;
// Add other inferred types as needed
// type ReadFileInput = z.infer<typeof ReadFileArgsSchema>;
// ... etc ...

// Interface for FileInfo (used by get_file_info and potentially others)
interface FileInfo {
    size: number;
    created: Date;
    modified: Date;
    accessed: Date;
    isDirectory: boolean;
    isFile: boolean;
    permissions: string; // e.g., '755'
}

// --- End of Part 1 ---
// --- Part 2: Tool Implementations (Core Logic) ---

// --- File/Directory Helper Implementations ---

/**
 * Retrieves detailed metadata about a file or directory.
 * @param filePath The validated absolute path to the file or directory.
 * @returns A Promise resolving to a FileInfo object.
 */
async function getFileStats(filePath: string): Promise<FileInfo> {
    // Assuming filePath is already validated and resolved by validatePath
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        // Extract octal permissions string (e.g., '755')
        permissions: (stats.mode & 0o777).toString(8),
    };
}

/**
 * Recursively searches for files within a directory structure matching a pattern,
 * respecting exclude patterns.
 * @param rootPath The validated absolute path to the root directory to start searching from.
 * @param pattern The case-insensitive substring pattern to search for in file/directory names.
 * @param excludePatterns An array of glob patterns to exclude.
 * @returns A Promise resolving to an array of absolute paths matching the criteria.
 */
async function searchFiles(
    rootPath: string,
    pattern: string,
    excludePatterns: string[] = []
): Promise<string[]> {
    const results: string[] = [];
    const searchPatternLower = pattern.toLowerCase();

    async function search(currentPath: string) {
        // Ensure we don't try to read disallowed directories encountered during recursion
        // This relies on the initial rootPath being validated.
        try {
            await validatePath(currentPath); // Quick check if still allowed (might be redundant if structure is strict)
        } catch (validationError) {
            console.warn(`Skipping search in ${currentPath}: ${validationError instanceof Error ? validationError.message : validationError}`);
            return; // Skip this path if validation fails
        }

        const entries = await fs.readdir(currentPath, {withFileTypes: true});

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(rootPath, fullPath);

            try {
                // Check exclude patterns first
                const shouldExclude = excludePatterns.some(excludeGlob =>
                    minimatch(relativePath, excludeGlob, {dot: true, matchBase: true})
                );

                if (shouldExclude) {
                    continue; // Skip this entry and its children if excluded
                }

                // Check if the entry name matches the search pattern
                if (entry.name.toLowerCase().includes(searchPatternLower)) {
                    results.push(fullPath); // Add the matching path
                }

                // Recurse into subdirectories if it's a directory
                if (entry.isDirectory()) {
                    // No need to call validatePath again here, recursion handles it at the start
                    await search(fullPath);
                }
            } catch (error) {
                // Log errors reading specific entries but continue searching others
                console.error(`Error processing entry ${fullPath} during search:`, error);
                continue;
            }
        }
    }

    await search(rootPath); // Start the recursive search
    return results;
}


// --- Smart Edit Implementation ---

/**
 * Applies a series of edits to a file using normalization, fuzzy matching,
 * and optional disambiguation via index. Manages the core logic for the 'smart' edit mode.
 *
 * @param filePath Validated absolute path to the file.
 * @param edits Array of edit operations ({ oldText, newText }).
 * @param normalizationOptions Options controlling normalization.
 * @param similarityThreshold Minimum similarity for fuzzy matching (0.0-1.0).
 * @param disambiguationIndex Optional 1-based index from AI to resolve ambiguity.
 * @param dryRun If true, returns diff/info without writing.
 * @param formatAfter If true, formats the code after edits.
 * @returns A Promise resolving to a success message string or an object for AMBIGUOUS/DRY_RUN status.
 */
async function applySmartEdits(
    filePath: string,
    edits: Array<{ oldText: string, newText: string }>,
    normalizationOptions: NormalizationOptions, // Now explicitly typed
    similarityThreshold: number,
    disambiguationIndex?: number,
    dryRun = false,
    formatAfter = false
): Promise<string | object> { // Return type clarified
    const originalContent = await fs.readFile(filePath, 'utf-8');

    // Normalize the entire file content once
    const normResultFile: NormalizationResult = normalizeCodeForMatching(originalContent, normalizationOptions);
    const normalizedFileContent = normResultFile.normalizedText;
    const fileMapping = normResultFile.mapping;

    // Array to store the details needed to apply chosen edits later
    const editApplications: Array<{
        originalStart: number;
        originalEnd: number;
        newText: string;
        similarity?: number;
        matchIndexUsed?: number; // 0-based index of match in found list
    }> = [];

    // Array to store context for ambiguous matches (only populated if ambiguity occurs)
    const ambiguousMatchesContext: Array<{
        index: number;
        originalLocation: { start: number; end: number };
        context: string
    }> = [];
    let isAmbiguous = false;        // Flag if ambiguity is detected in the current request
    let firstAmbiguityDetected = false; // Tracks if we've already prepared context for the *first* ambiguous edit

    // --- Stage 1: Find matches for all edits ---
    for (let editIndex = 0; editIndex < edits.length; editIndex++) {
        const edit = edits[editIndex];

        // Check for empty oldText early
        if (!edit.oldText) {
            console.warn(`Edit ${editIndex + 1}: oldText is empty. Skipping.`);
            continue; // Skip edits with empty search patterns
        }

        const normResultPattern: NormalizationResult = normalizeCodeForMatching(edit.oldText, normalizationOptions);
        const normalizedSearchPattern = normResultPattern.normalizedText;

        // If normalization results in an empty pattern, skip (unless original was also empty, handled above)
        if (!normalizedSearchPattern) {
            console.warn(`Edit ${editIndex + 1}: Normalized search pattern became empty for non-empty oldText. Skipping.`);
            continue;
        }

        const matches = findFuzzyMatches(
            normalizedFileContent,
            normalizedSearchPattern,
            similarityThreshold
        );

        let chosenMatch: { start: number; end: number; similarity: number } | null = null;
        let matchIndexUsed: number | undefined = undefined; // Track which match index was used

        // --- Logic for choosing match or detecting ambiguity ---
        if (matches.length === 0) {
            // No matches found at all
            throw new Error(`Edit ${editIndex + 1}: Pattern not found for oldText: "${edit.oldText.substring(0, 50)}..." (Similarity threshold: ${similarityThreshold}, After normalization)`);
        } else if (matches.length === 1) {
            // Exactly one match found
            if (disambiguationIndex && editIndex === 0) {
                console.warn(`Edit ${editIndex + 1}: Disambiguation index ${disambiguationIndex} provided, but only one match found. Using the single match.`);
            }
            chosenMatch = matches[0];
            matchIndexUsed = 0; // Index of the single match
        } else { // matches.length > 1
            // Multiple matches found
            if (disambiguationIndex && editIndex === 0) {
                // Disambiguation index IS provided, and this is the first edit. Use the index.
                if (disambiguationIndex > 0 && disambiguationIndex <= matches.length) {
                    chosenMatch = matches[disambiguationIndex - 1];
                    matchIndexUsed = disambiguationIndex - 1; // Store 0-based index
                    console.error(`Using disambiguation index ${disambiguationIndex} (0-based: ${matchIndexUsed}) for edit ${editIndex + 1}.`);
                    // We've resolved the ambiguity for this edit
                } else {
                    // Invalid index provided for the current set of matches
                    throw new Error(`Edit ${editIndex + 1}: Invalid disambiguation index ${disambiguationIndex}. Found ${matches.length} matches this time.`);
                }
            } else if (disambiguationIndex && editIndex > 0) {
                // Disambiguation index provided, but it's NOT the first edit.
                // Current protocol: Ignore index for subsequent edits, assume it was for the first.
                console.warn(`Edit ${editIndex + 1}: Disambiguation index ${disambiguationIndex} ignored as it applies only to the first ambiguous edit in a request.`);
                // Since multiple matches exist and we ignored the index, this edit is ambiguous *now*.
                isAmbiguous = true;
                if (!firstAmbiguityDetected) {
                    // This is the first time we hit ambiguity *in this request* (even if it's not edit 0)
                    firstAmbiguityDetected = true;
                    console.error(`Ambiguity detected for edit ${editIndex + 1} (index ignored), preparing context...`);
                    // Collect context for THIS ambiguity
                    for (let i = 0; i < matches.length; i++) { /* ... context collection logic ... */
                        const match = matches[i];
                        const originalRange = translateNormalizedRangeToOriginal(match.start, match.end, fileMapping);
                        if (originalRange) {
                            const context = extractContextLines(originalContent, originalRange.originalStart, originalRange.originalEnd);
                            ambiguousMatchesContext.push({
                                index: i + 1,
                                originalLocation: {start: originalRange.originalStart, end: originalRange.originalEnd},
                                context
                            });
                        } else {
                            ambiguousMatchesContext.push({
                                index: i + 1,
                                originalLocation: {start: -1, end: -1},
                                context: "[Failed to map location]"
                            });
                        }
                    }
                }
            } else { // No disambiguation index provided, and multiple matches found
                // This edit is ambiguous.
                isAmbiguous = true;
                if (!firstAmbiguityDetected) {
                    // First ambiguity detected in this request. Collect context.
                    firstAmbiguityDetected = true;
                    console.error(`Ambiguity detected for edit ${editIndex + 1}, preparing context...`);
                    for (let i = 0; i < matches.length; i++) { /* ... context collection logic (same as above) ... */
                        const match = matches[i];
                        const originalRange = translateNormalizedRangeToOriginal(match.start, match.end, fileMapping);
                        if (originalRange) {
                            const context = extractContextLines(originalContent, originalRange.originalStart, originalRange.originalEnd);
                            ambiguousMatchesContext.push({
                                index: i + 1,
                                originalLocation: {start: originalRange.originalStart, end: originalRange.originalEnd},
                                context
                            });
                        } else {
                            ambiguousMatchesContext.push({
                                index: i + 1,
                                originalLocation: {start: -1, end: -1},
                                context: "[Failed to map location]"
                            });
                        }
                    }
                }
            }
        }

        // If a match was successfully chosen for this edit, store its details for application later
        if (chosenMatch) {
            const originalRange = translateNormalizedRangeToOriginal(chosenMatch.start, chosenMatch.end, fileMapping);
            if (!originalRange) {
                // If mapping fails even after finding a match, treat as an error for this edit
                throw new Error(`Edit ${editIndex + 1}: Failed to map chosen match (Similarity: ${chosenMatch.similarity.toFixed(2)}) back to original file location.`);
            }
            editApplications.push({
                originalStart: originalRange.originalStart,
                originalEnd: originalRange.originalEnd,
                newText: edit.newText,
                similarity: chosenMatch.similarity,
                matchIndexUsed: matchIndexUsed
            });
        } else if (isAmbiguous && firstAmbiguityDetected) {
            // If ambiguity was detected and context prepared, stop processing further edits in this request.
            console.error(`Stopping edit processing at index ${editIndex} due to ambiguity.`);
            break; // Exit the loop early to return AMBIGUOUS status
        } else if (!chosenMatch && !isAmbiguous) {
            // This state should ideally not be reached if logic is sound
            throw new Error(`Internal error in edit ${editIndex + 1}: No match chosen and no ambiguity detected.`);
        }
    } // --- End loop through edits ---


    // --- Stage 2: Handle Ambiguity or Proceed ---
    if (isAmbiguous) {
        // If the loop finished (or broke early) because ambiguity was detected and context prepared
        return {
            status: "AMBIGUOUS",
            message: `Multiple potential matches found for the first ambiguous edit encountered. Please specify the index (1-based) in 'disambiguationIndex' on your next request.`,
            matches: ambiguousMatchesContext, // Contains context for the first ambiguous edit
        };
    }

    // If we reach here, all *processed* edits resulted in a single chosen match (either directly or via index)
    // Check if the number of applications matches the number of *valid* input edits processed before any ambiguity break
    const processedEditsCount = isAmbiguous ? editApplications.length : edits.filter(e => e.oldText && normalizeCodeForMatching(e.oldText, normalizationOptions).normalizedText).length; // Count valid edits if no ambiguity break
    if (editApplications.length !== processedEditsCount && !isAmbiguous) {
        console.warn(`Mismatch between applied edits (${editApplications.length}) and processed valid edits (${processedEditsCount}). Some edits might have been skipped unexpectedly.`);
        // Decide if this should be a hard error or just a warning. Let's allow proceeding but warn.
    }
    if (editApplications.length === 0) {
        return "No valid edits were specified or could be applied."; // Or throw error if edits array was non-empty initially
    }


    // --- Stage 3: Apply Edits (Bottom-up) ---
    let modifiedContent = originalContent;
    // Sort by original start position, descending, to apply edits safely without recalculating offsets
    editApplications.sort((a, b) => b.originalStart - a.originalStart);

    for (const app of editApplications) {
        // Double-check ranges before applying
        if (app.originalStart < 0 || app.originalEnd < 0 || app.originalEnd < app.originalStart) {
            throw new Error(`Internal error: Invalid original range calculated for replacement: ${app.originalStart}-${app.originalEnd}`);
        }
        // Use Math.min to prevent exceeding current content length (important if content shrinks during replacements)
        const safeStart = Math.min(app.originalStart, modifiedContent.length);
        const safeEnd = Math.min(app.originalEnd, modifiedContent.length);

        if (safeEnd < safeStart) {
            console.warn(`Attempting to apply edit with end (${safeEnd}) before start (${safeStart}). Skipping this edit.`);
            continue;
        }


        modifiedContent =
            modifiedContent.slice(0, safeStart) +
            app.newText +
            modifiedContent.slice(safeEnd);
    }


    // --- Stage 4: Handle dryRun ---
    if (dryRun) {
        const diff = createUnifiedDiff(originalContent, modifiedContent, filePath);
        // Provide useful info about which edits were applied and how
        const appliedEditsInfo = editApplications
            .sort((a, b) => a.originalStart - b.originalStart) // Sort back to original order for clarity
            .map(app => ({
                originalRange: {start: app.originalStart, end: app.originalEnd},
                newTextLength: app.newText.length,
                similarity: app.similarity?.toFixed(4), // Include similarity score
                matchIndexUsed: app.matchIndexUsed // Include which match index was used (0-based)
            }));
        return {
            status: "DRY_RUN_SUCCESS",
            message: "Dry run successful. Changes calculated.",
            diff: diff,
            appliedEditsInfo: appliedEditsInfo
        };
    }


    // --- Stage 5: Format (if requested) ---
    let formattedContent = modifiedContent; // Start with the edited content
    if (formatAfter) {
        const language = detectLanguage(filePath);
        if (language) {
            try {
                console.error(`Formatting code for language: ${language}`);
                formattedContent = await formatCode(formattedContent, language, filePath);
                console.error("Formatting successful.");
            } catch (formatError: any) {
                console.warn(`Formatting failed: ${formatError.message}. Proceeding with unformatted content.`);
                // Keep formattedContent = modifiedContent
            }
        } else {
            console.warn(`Cannot format file: Language not detected for ${filePath}`);
        }
    }


    // --- Stage 6: Write File & Commit ---
    const finalContentToWrite = formattedContent; // Use the potentially formatted content
    try {
        // Optional: Git status check before writing
        try {
            await execAsync(`git status --porcelain "${filePath}"`);
            // Could check output here, e.g., if file has other uncommitted changes
        } catch (gitStatusError) {
            // Ignore errors if file isn't tracked or git isn't available
            console.warn(`Git status check failed or file not tracked. Proceeding with write.`);
        }

        await fs.writeFile(filePath, finalContentToWrite, 'utf-8');
        console.error(`File written successfully: ${filePath}`);

        // Optional: Add and commit using Git
        try {
            await execAsync(`git add "${filePath}"`);
            const commitMsg = `MCP: Applied smart edit to ${path.basename(filePath)}`;
            // Use --no-verify to skip pre-commit hooks if they might interfere
            await execAsync(`git commit --no-verify -m "${commitMsg}"`);
            console.error(`Changes committed successfully.`);
        } catch (gitCommitError: any) {
            console.error(`Git add/commit failed: ${gitCommitError.message}. File was modified but not committed.`);
            // Don't revert, just report the commit failure. The file *is* changed.
            return `File '${filePath}' edited${formatAfter ? ' and formatted' : ''} successfully, BUT Git commit failed: ${gitCommitError.message}`;
        }

        return `File '${filePath}' edited${formatAfter ? ' and formatted' : ''} and committed successfully.`;

    } catch (writeError: any) {
        // Error during fs.writeFile
        throw new Error(`Failed to write file "${filePath}": ${writeError.message}`);
    }
} // --- End of applySmartEdits ---


// --- Server Instantiation ---

// Create the MCP server instance
const server = new Server(
    { // Server Information
        name: "secure-filesystem-mcp-server",
        version: "0.3.0", // Updated version
    },
    { // Server Options/Capabilities
        capabilities: {
            // Declare supported capabilities, e.g., which tools are available
            tools: {}
        },
    }
);

// --- End of Part 2 ---

// --- Part 3: Tool Definitions, Request Handlers, and Server Start ---

// --- Tool Definitions Array ---
// Define the list of tools the server provides, using the schemas defined in Part 1.
// --- CORRECTION: Use ToolSchema as the type for the array elements ---
const tools =
    [
        { // READ FILE
            name: "read_file",
            description:
                "Read the complete contents of a file from the file system. " +
                "Handles UTF-8 encoding. Only works within allowed directories.",
            inputSchema: zodToJsonSchema(ReadFileArgsSchema) as any,
        },
        { // READ MULTIPLE FILES
            name: "read_multiple_files",
            description:
                "Read the contents of multiple files simultaneously. Returns results concatenated with file paths. " +
                "Failed reads for individual files are reported but don't stop the operation. Only works within allowed directories.",
            inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as any,
        },
        { // WRITE FILE
            name: "write_file",
            description:
                "Create a new file or completely overwrite an existing file with new content. " +
                "Use with caution. Only works within allowed directories.",
            inputSchema: zodToJsonSchema(WriteFileArgsSchema) as any,
        },
        { // EDIT FILE (Using the NEW schema)
            name: "edit_file",
            description:
                "Selectively edits a file using different modes: 'smart' (default, uses normalization/fuzzy matching/disambiguation) or 'patch' (apply unified diff). " +
                "Supports dryRun=true to preview changes. Can auto-format code after edits/patch with formatAfter=true. " +
                "Only works within allowed directories.",
            inputSchema: zodToJsonSchema(EditFileArgsSchema) as any, // Use the NEW schema
        },
        { // CREATE DIRECTORY
            name: "create_directory",
            description:
                "Create a new directory or ensure a directory exists. Creates parent directories if needed (`mkdir -p`). " +
                "Succeeds silently if the directory already exists. Only works within allowed directories.",
            inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as any,
        },
        { // LIST DIRECTORY
            name: "list_directory",
            description:
                "List directory contents with [FILE] or [DIR] prefixes. " +
                "Only works within allowed directories.",
            inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as any,
        },
        { // DIRECTORY TREE
            name: "directory_tree",
            description:
                "Get a recursive tree view of files and directories as a JSON structure. " +
                "Each entry includes 'name', 'type' (file/directory), and 'children' for directories (empty array if dir is empty). " +
                "Only works within allowed directories.",
            inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema) as any,
        },
        { // MOVE FILE
            name: "move_file",
            description:
                "Move or rename files and directories using `fs.rename`. " +
                "Fails if the destination already exists. Both source and destination must be within allowed directories.",
            inputSchema: zodToJsonSchema(MoveFileArgsSchema) as any,
        },
        { // SEARCH FILES
            name: "search_files",
            description:
                "Recursively search for files/directories matching a pattern (case-insensitive substring). " +
                "Respects exclude patterns (glob format). Only searches within allowed directories.",
            inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as any,
        },
        { // GET FILE INFO
            name: "get_file_info",
            description:
                "Retrieve detailed metadata about a file or directory (size, dates, type, permissions). " +
                "Only works within allowed directories.",
            inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as any,
        },
        { // LIST ALLOWED DIRECTORIES
            name: "list_allowed_directories",
            description:
                "Returns the list of absolute root directories that this server instance is allowed to access.",
            inputSchema: zodToJsonSchema(z.object({})) as any,
        },
    ];


// --- Request Handlers ---

// Handler for listing available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Return the defined tools array, matching MCP response structure
    return {tools};
});

// Handler for executing a specific tool
// --- CORRECTION: Ensure return type matches expected MCP response ---
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<{
    output?: any;
    error?: { message: string; stack?: string }
}> => {
    try {
        // Basic validation of the incoming request structure
        if (!request.params || typeof request.params !== 'object') {
            throw new Error("Invalid request structure: Missing or invalid 'params'.");
        }
        const name = request.params.name;
        const args = request.params.arguments; // Arguments from the request

        if (typeof name !== 'string' || !name) throw new Error("Invalid or missing tool name.");
        if (args !== undefined && args !== null && typeof args !== 'object') throw new Error("Invalid tool arguments format.");

        // Find the corresponding tool definition
        const toolDefinition = tools.find(t => t.name === name);
        if (!toolDefinition) {
            throw new Error(`Unknown tool: ${name}`);
        }

        console.error(`Executing tool: ${name}`);

        // Execute the specific tool logic based on its name
        switch (name) {
            case "read_file": {
                // --- CORRECTION: Use result of parse directly ---
                const parsedArgs = ReadFileArgsSchema.parse(args ?? {});
                const validPath = await validatePath(parsedArgs.path);
                const content = await fs.readFile(validPath, "utf-8");
                // --- CORRECTION: Wrap result in { output: ... } ---
                return {output: {content: [{type: "text", text: content}]}};
            }

            case "read_multiple_files": {
                const parsedArgs = ReadMultipleFilesArgsSchema.parse(args ?? {});
                const results = await Promise.allSettled(
                    parsedArgs.paths.map(async (filePath: string) => {
                        const validPath = await validatePath(filePath);
                        const content = await fs.readFile(validPath, "utf-8");
                        return `--- File: ${filePath} ---\n${content}`;
                    })
                );
                const formattedResults = results.map((result, index) => {
                    if (result.status === 'fulfilled') {
                        return result.value;
                    } else {
                        console.error(`Error reading file ${parsedArgs.paths[index]}:`, result.reason);
                        return `--- File: ${parsedArgs.paths[index]} ---\nError: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
                    }
                }).join("\n\n");
                return {output: {content: [{type: "text", text: formattedResults}]}};
            }

            case "write_file": {
                // --- CORRECTION: Use result of parse directly ---
                const parsedArgs = WriteFileArgsSchema.parse(args ?? {});
                const validPath = await validatePath(parsedArgs.path);
                const parentDir = path.dirname(validPath);
                await fs.mkdir(parentDir, {recursive: true});
                await fs.writeFile(validPath, parsedArgs.content, "utf-8");
                // --- CORRECTION: Wrap result in { output: ... } ---
                return {output: {content: [{type: "text", text: `Successfully wrote to ${parsedArgs.path}`}]}};
            }

            case "edit_file": {
                // --- CORRECTION: Use result of parse directly ---
                const parsedArgs = EditFileArgsSchema.parse(args ?? {});
                const validPath = await validatePath(parsedArgs.path);

                let result: string | object; // Can be string or structured object

                if (parsedArgs.mode === 'patch') {
                    result = await applyPatchToFile(validPath, parsedArgs.patch!, parsedArgs.dryRun, parsedArgs.formatAfter);
                } else if (parsedArgs.mode === 'smart') {
                    result = await applySmartEdits(
                        validPath,
                        parsedArgs.edits!,
                        parsedArgs.normalizationOptions,
                        parsedArgs.similarityThreshold,
                        parsedArgs.disambiguationIndex,
                        parsedArgs.dryRun,
                        parsedArgs.formatAfter
                    );
                } else {
                    throw new Error(`Internal error: Invalid mode encountered: ${parsedArgs.mode}`);
                }

                // --- CORRECTION: Wrap result correctly ---
                if (typeof result === 'string') {
                    // Simple success message or basic dry run string
                    return {output: {content: [{type: "text", text: result}]}};
                } else if (typeof result === 'object' && result !== null) {
                    // Structured response (AMBIGUOUS or detailed DRY_RUN_SUCCESS)
                    // Return the object directly as the output value
                    return {output: result};
                } else {
                    throw new Error("Edit operation returned an unexpected result type.");
                }
            }

            case "create_directory": {
                const parsedArgs = CreateDirectoryArgsSchema.parse(args ?? {});
                const validPath = await validatePath(parsedArgs.path);
                await fs.mkdir(validPath, {recursive: true});
                return {output: {content: [{type: "text", text: `Directory ensured at ${parsedArgs.path}`}]}};
            }

            case "list_directory": {
                const parsedArgs = ListDirectoryArgsSchema.parse(args ?? {});
                const validPath = await validatePath(parsedArgs.path);
                const entries = await fs.readdir(validPath, {withFileTypes: true});
                const formatted = entries
                    .map((entry) => `${entry.isDirectory() ? "[DIR] " : "[FILE]"} ${entry.name}`)
                    .join("\n");
                return {output: {content: [{type: "text", text: formatted || "(Directory is empty)"}]}};
            }

            case "directory_tree": {
                const parsedArgs = DirectoryTreeArgsSchema.parse(args ?? {});
                const validRootPath = await validatePath(parsedArgs.path);

                interface TreeEntry {
                    name: string;
                    type: 'file' | 'directory';
                    children?: TreeEntry[];
                }

                async function buildTree(currentPath: string): Promise<TreeEntry[]> {
                    let entries;
                    try {
                        entries = await fs.readdir(currentPath, {withFileTypes: true});
                    } catch (readErr) {
                        console.error(`Error reading directory ${currentPath} for tree:`, readErr);
                        return [];
                    }

                    const children: TreeEntry[] = [];
                    for (const entry of entries) {
                        const entryData: TreeEntry = {
                            name: entry.name,
                            type: entry.isDirectory() ? 'directory' : 'file'
                        };
                        if (entry.isDirectory()) {
                            entryData.children = await buildTree(path.join(currentPath, entry.name));
                        }
                        children.push(entryData);
                    }
                    children.sort((a, b) => {
                        if (a.type === b.type) return a.name.localeCompare(b.name);
                        return a.type === 'directory' ? -1 : 1;
                    });
                    return children;
                }

                const treeData = {
                    name: path.basename(validRootPath),
                    type: 'directory',
                    children: await buildTree(validRootPath)
                };
                // Return the structured JSON object directly as output
                return {output: treeData};
            }

            case "move_file": {
                const parsedArgs = MoveFileArgsSchema.parse(args ?? {});
                const validSourcePath = await validatePath(parsedArgs.source);
                const validDestPath = await validatePath(parsedArgs.destination);
                try {
                    await fs.access(validDestPath);
                    throw new Error(`Destination path "${parsedArgs.destination}" already exists.`);
                } catch (accessError: any) {
                    if (accessError.code !== 'ENOENT') throw accessError;
                }
                const destParentDir = path.dirname(validDestPath);
                await fs.mkdir(destParentDir, {recursive: true});
                await fs.rename(validSourcePath, validDestPath);
                return {
                    output: {
                        content: [{
                            type: "text",
                            text: `Successfully moved ${parsedArgs.source} to ${parsedArgs.destination}`
                        }]
                    }
                };
            }

            case "search_files": {
                const parsedArgs = SearchFilesArgsSchema.parse(args ?? {});
                const validPath = await validatePath(parsedArgs.path);
                const results = await searchFiles(validPath, parsedArgs.pattern, parsedArgs.excludePatterns);
                return {
                    output: {
                        content: [{
                            type: "text",
                            text: results.length > 0 ? results.join("\n") : "No matches found"
                        }]
                    }
                };
            }

            case "get_file_info": {
                const parsedArgs = GetFileInfoArgsSchema.parse(args ?? {});
                const validPath = await validatePath(parsedArgs.path);
                const info = await getFileStats(validPath);
                // Return structured info object
                return {output: info};
            }

            case "list_allowed_directories": {
                z.object({}).parse(args ?? {}); // Validate no args passed
                return {output: {allowedDirectories: allowedDirectories}}; // Return as structured data
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error: any) { // Catch errors consistently
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error processing tool request for "${request?.params?.name}": ${errorMessage}`, error.stack);
        // --- CORRECTION: Return error in standard MCP format ---
        return {
            error: {
                message: errorMessage,
                // Optionally include stack in non-production environments
                // stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
            }
        };
    }
});


// --- Server Start Logic ---

// Validate allowed directories exist before starting
async function validateInitialDirectories() {
    console.error("Validating allowed directories...");
    if (!allowedDirectories || allowedDirectories.length === 0) {
        throw new Error("Configuration error: No allowed directories were defined.");
    }
    for (const dir of allowedDirectories) {
        try {
            const stats = await fs.stat(dir);
            if (!stats.isDirectory()) {
                throw new Error(`Specified allowed path is not a directory: ${dir}`);
            }
            console.error(`- Allowed directory confirmed: ${dir}`);
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                throw new Error(`Specified allowed directory does not exist: ${dir}`);
            } else {
                throw new Error(`Error accessing allowed directory ${dir}: ${err.message}`);
            }
        }
    }
    console.error("All allowed directories validated successfully.");
}

async function runServer() {
    await validateInitialDirectories();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Secure MCP Filesystem Server running on stdio"); // Use console.error for logs
    console.error("Allowed directories:", allowedDirectories);
    console.error("Ready to process requests...");
}

runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});

// --- End of File ---