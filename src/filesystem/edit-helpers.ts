// edit-helpers.ts
import fs from 'fs/promises';
import path from 'path';
import {diffLines, createTwoFilesPatch} from 'diff'; // Used for createUnifiedDiff
import {formatCode} from './formatters.js'; // Used by legacy applyFileEdits
import {compareTwoStrings} from 'string-similarity'; // Import fuzzy matching

// Imports for smart edit logic
import {exec} from 'child_process'; // For Git commands
import {promisify} from 'util';     // For Git commands

const execAsync = promisify(exec); // Define promisified exec

// --- Interfaces ---

/**
 * Options for controlling code normalization before matching.
 */
export interface NormalizationOptions {
    ignoreComments?: boolean;
    ignoreLeadingWhitespace?: boolean;
    ignoreTrailingWhitespace?: boolean;
    ignoreInternalWhitespace?: 'collapse' | 'remove' | 'keep';
    ignoreBlankLines?: boolean;
    caseSensitive?: boolean;
}

/**
 * Represents a mapping between original and normalized text segments.
 * Note: Current implementation provides line-level mapping approximation.
 */
export interface MappingEntry {
    originalStart: number;  // Character offset in original text
    originalEnd: number;    // Exclusive end character offset in original text
    normalizedStart: number;// Character offset in normalized text
    normalizedEnd: number;  // Exclusive end character offset in normalized text
}

/**
 * Result object returned by the enhanced normalization function.
 */
export interface NormalizationResult {
    normalizedText: string;
    mapping: MappingEntry[]; // Array of mapping entries
}

// --- Core Helper Functions ---

/**
 * Normalizes line endings in a string to LF ('\n').
 * @param text The input string.
 * @returns The string with normalized line endings.
 */
export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Creates a unified diff patch string between two text contents.
 * @param originalContent The original text.
 * @param newContent The new text.
 * @param filepath The filepath to use in the diff header (optional).
 * @returns A string representing the unified diff.
 */
export function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
    // Ensure consistent line endings for diff calculation
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);

    return createTwoFilesPatch(
        filepath, // Original file path label
        filepath, // New file path label
        normalizedOriginal,
        normalizedNew,
        'original', // Original header label (optional)
        'modified', // New header label (optional)
        {context: 3} // Number of context lines
    );
}

/**
 * Detects the programming language based on a file's extension.
 * @param filePath The path to the file.
 * @returns The detected language identifier (e.g., 'typescript', 'dart') or null if unknown.
 */
export function detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    // Add or modify languages as needed
    const languageMap: Record<string, string> = {
        '.js': 'javascript',
        '.ts': 'typescript',
        '.jsx': 'javascript', // Consider treating JSX as JS for common formatters like Prettier
        '.tsx': 'typescript', // Consider treating TSX as TS
        '.py': 'python',
        '.dart': 'dart',
        '.java': 'java',
        '.go': 'go',
        '.cs': 'csharp',
        '.cpp': 'cpp',
        '.c': 'c',
        '.rb': 'ruby',
        '.php': 'php',
        '.swift': 'swift',
        '.kt': 'kotlin',
        '.rs': 'rust',
        '.html': 'html',
        '.css': 'css',
        '.json': 'json',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.md': 'markdown',
        '.sh': 'shell',
        '.bash': 'shell',
        '.zsh': 'shell',
        'dockerfile': 'dockerfile', // Handle files named Dockerfile
        '.dockerfile': 'dockerfile',
    };

    return languageMap[ext] || (path.basename(filePath).toLowerCase() === 'dockerfile' ? 'dockerfile' : null);
}

// --- Normalization and Mapping ---

/**
 * Legacy function overload signature (kept for potential backward compatibility checks, but implementation unified).
 * Normalizes code for matching based on the specified mode ('exact', 'structure', 'semantic').
 */
export function normalizeCodeForMatching(text: string, mode: string): string;
/**
 * Enhanced function overload signature.
 * Normalizes code with detailed options and provides offset mapping information.
 */
export function normalizeCodeForMatching(text: string, options: NormalizationOptions): NormalizationResult;

/**
 * Normalizes code for matching. Handles both legacy mode strings and detailed options object.
 * When using the options object, it returns the normalized text and mapping information.
 *
 * @param originalText The original code string.
 * @param modeOrOptions A legacy mode string ('exact', 'structure') or a NormalizationOptions object.
 * @returns Either the normalized string (for legacy modes) or a NormalizationResult object.
 */
export function normalizeCodeForMatching(
    originalText: string,
    modeOrOptions: string | NormalizationOptions
): string | NormalizationResult {

    // --- Handle Legacy Mode (Returns only string) ---
    if (typeof modeOrOptions === 'string') {
        const mode = modeOrOptions;
        console.warn(`Legacy normalizeCodeForMatching called with mode: ${mode}. Consider using NormalizationOptions object.`);
        if (mode === 'exact') {
            return originalText;
        }

        let normalized = normalizeLineEndings(originalText); // Start with consistent endings

        if (mode === 'structure' || mode === 'semantic') { // Treat semantic like structure for legacy normalization
            // Remove multi-line comments (basic approach)
            normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
            // Remove single-line comments
            normalized = normalized.replace(/\/\/.*$/gm, '');
            // Remove trailing whitespace from lines
            normalized = normalized.split('\n').map(line => line.trimEnd()).join('\n');
            // Collapse multiple spaces/tabs within lines to single spaces (respects structure more than full trim)
            normalized = normalized.replace(/[ \t]+/g, ' ');
            // Remove blank lines (lines containing only whitespace)
            normalized = normalized.split('\n').filter(line => line.trim().length > 0).join('\n');
        }
        return normalized;
    }

    // --- New Implementation with NormalizationOptions and Mapping ---
    const options = modeOrOptions;
    const {
        ignoreComments = true,
        ignoreLeadingWhitespace = true,
        ignoreTrailingWhitespace = true,
        ignoreInternalWhitespace = 'collapse',
        ignoreBlankLines = true,
        caseSensitive = true,
    } = options;

    let normalized = '';
    const mapping: MappingEntry[] = [];
    let currentOriginalPos = 0;
    let currentNormalizedPos = 0;
    // --- FIX: Start with normalized line endings ---
    const originalTextNormalizedEndings = normalizeLineEndings(originalText);

    // --- FIX: Remove multi-line comments *before* splitting into lines ---
    // This handles comments spanning multiple lines much better.
    // Use a placeholder for removed comments to aid mapping later if needed, or just remove.
    // Basic removal:
    let textWithoutMultiComments = originalTextNormalizedEndings.replace(/\/\*[\s\S]*?\*\//g, '');
    // Note: Tracking mapping accurately through this regex replacement is tricky.
    // The current line-level mapping will become less precise.
    const lines = textWithoutMultiComments.split('\n'); // Split AFTER removing multiline comments

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const originalLineStartPos = currentOriginalPos; // Still tracks original position *before* normalization

        let processedLine = line;

        // 1. Handle SINGLE-line Comments
        let commentStrippedLine = processedLine;
        if (ignoreComments) {
            commentStrippedLine = commentStrippedLine.replace(/\/\/.*$/, ''); // Only handle // comments now
        }

        // 2. Handle Whitespace
        let whitespaceProcessedLine = commentStrippedLine;
        if (ignoreLeadingWhitespace) {
            whitespaceProcessedLine = whitespaceProcessedLine.trimStart();
        }
        if (ignoreTrailingWhitespace) {
            whitespaceProcessedLine = whitespaceProcessedLine.trimEnd();
        }

        // --- FIX: Apply internal whitespace AFTER trimming ends ---
        if (ignoreInternalWhitespace === 'collapse') {
            // Collapse multiple whitespace chars (including space, tab) to a single space
            whitespaceProcessedLine = whitespaceProcessedLine.replace(/\s\s+/g, ' '); // Target multiple spaces
        } else if (ignoreInternalWhitespace === 'remove') {
            whitespaceProcessedLine = whitespaceProcessedLine.replace(/\s+/g, ''); // Remove all whitespace
        }

        // 3. Handle Blank Lines (Check AFTER all trimming/collapsing)
        const isEffectivelyBlank = whitespaceProcessedLine.trim() === ''; // Check if trimming results in empty
        if (ignoreBlankLines && isEffectivelyBlank) {
            // --- FIX: Advance original position correctly based on the original line length ---
            // Find the corresponding original line range before modifications
            let originalLineLength = 0;
            let tempPos = 0;
            const originalLinesForLength = originalTextNormalizedEndings.split('\n');
            if (i < originalLinesForLength.length) {
                originalLineLength = originalLinesForLength[i].length + 1; // +1 for newline
            } else {
                // Fallback if line index is out of bounds (shouldn't happen)
                originalLineLength = line.length + 1; // Use the potentially modified line length
            }
            currentOriginalPos += originalLineLength; // Advance past original line + newline
            continue; // Skip adding this line
        }

        // 4. Handle Case Sensitivity
        const finalLine = caseSensitive ? whitespaceProcessedLine : whitespaceProcessedLine.toLowerCase();

        // 5. Add to Normalized Output and Create Mapping
        const normalizedLineStartPos = currentNormalizedPos;
        normalized += finalLine + '\n';
        currentNormalizedPos += finalLine.length + 1;
        const normalizedLineEndPos = currentNormalizedPos;

        // --- Mapping still approximate ---
        const originalEndPos = currentOriginalPos + line.length + 1; // End of the original line segment corresponding to this processed line
        mapping.push({
            originalStart: originalLineStartPos,
            originalEnd: originalEndPos,
            normalizedStart: normalizedLineStartPos,
            normalizedEnd: normalizedLineEndPos,
        });

        // Advance original position based on the original line processed
        currentOriginalPos = originalEndPos;
    }

    // Remove final trailing newline if the original text didn't have one
    if (normalized.endsWith('\n') && !normalizeLineEndings(originalText).endsWith('\n')) {
        normalized = normalized.slice(0, -1);
        // Adjust last mapping entry if it exists
        if (mapping.length > 0) {
            const lastEntry = mapping[mapping.length - 1];
            // Only adjust if the last mapping corresponds to the removed newline
            if (lastEntry.normalizedEnd === currentNormalizedPos) {
                lastEntry.normalizedEnd -= 1;
            }
        }
    }

    // --- Mapping Caveat ---
    // This mapping tracks correspondence between chunks of the original text (often whole lines)
    // and their processed counterparts in the normalized text. It's suitable for locating the
    // *region* in the original file but not for exact character-to-character mapping during
    // heavy normalization (like comment removal or internal whitespace collapse).
    // The `translateNormalizedRangeToOriginal` function uses this approximate mapping.

    return {normalizedText: normalized, mapping};
}


/**
 * Translates a character offset range from the normalized text back to the
 * approximate corresponding range in the original text using the mapping table.
 *
 * @param normalizedStart Start character offset in the normalized text.
 * @param normalizedEnd Exclusive end character offset in the normalized text.
 * @param mapping The mapping array generated by `normalizeCodeForMatching`.
 * @returns An object with `originalStart` and `originalEnd` offsets, or null if mapping fails.
 */
export function translateNormalizedRangeToOriginal(
    normalizedStart: number,
    normalizedEnd: number, // exclusive
    mapping: MappingEntry[]
): { originalStart: number; originalEnd: number } | null {

    let startEntry: MappingEntry | null = null;
    let endEntry: MappingEntry | null = null;

    // Find the mapping entry that *starts at or before* and *ends at or after* the normalized start offset.
    for (const entry of mapping) {
        if (normalizedStart >= entry.normalizedStart && normalizedStart < entry.normalizedEnd) {
            startEntry = entry;
            break; // Found the entry containing the start
        }
        // Handle case where start offset falls exactly between entries (use the later entry)
        if (normalizedStart === entry.normalizedEnd && entry !== mapping[mapping.length - 1]) {
            startEntry = mapping[mapping.indexOf(entry) + 1] ?? entry;
            break;
        }
        // Fallback: if start is beyond last entry's norm end, maybe use last entry?
        if (entry === mapping[mapping.length - 1] && normalizedStart >= entry.normalizedEnd) {
            startEntry = entry;
            break;
        }
    }
    // If start not found after loop, maybe it's before the first entry?
    if (!startEntry && mapping.length > 0 && normalizedStart < mapping[0].normalizedStart) {
        startEntry = mapping[0];
    }


    // Find the mapping entry that *starts at or before* and *ends at or after* the normalized end offset - 1.
    const effectiveNormalizedEnd = Math.max(normalizedStart, normalizedEnd - 1); // End is exclusive, look for the char before it
    for (let i = mapping.length - 1; i >= 0; i--) { // Search backwards often faster for end
        const entry = mapping[i];
        if (effectiveNormalizedEnd >= entry.normalizedStart && effectiveNormalizedEnd < entry.normalizedEnd) {
            endEntry = entry;
            break; // Found the entry containing the end
        }
        // Handle case where end offset falls exactly at the start of an entry (use the previous entry)
        if (effectiveNormalizedEnd + 1 === entry.normalizedStart && i > 0) {
            endEntry = mapping[i - 1];
            break;
        }
        // Fallback: if end is before the first entry's norm start, maybe use first entry?
        if (entry === mapping[0] && effectiveNormalizedEnd < entry.normalizedStart) {
            endEntry = entry;
            break;
        }
    }
    // If end not found after loop, maybe it's after the last entry?
    if (!endEntry && mapping.length > 0 && effectiveNormalizedEnd >= mapping[mapping.length - 1].normalizedEnd) {
        endEntry = mapping[mapping.length - 1];
    }


    if (startEntry && endEntry) {
        // Use the start of the startEntry's original range
        // and the end of the endEntry's original range.
        const originalStart = startEntry.originalStart;
        let originalEnd = endEntry.originalEnd;

        // Adjust end offset: Mapping's originalEnd includes the newline character
        // of the last original line contributing to that mapping entry. We usually
        // want the offset *before* that newline for replacement purposes.
        // Only adjust if the range isn't empty and the original end is greater than start.
        if (originalEnd > originalStart && originalEnd > 0) {
            // We make the end exclusive, similar to how slice works.
            // The mapping's originalEnd is already exclusive. So no change needed?
            // Let's test. If mapping is {origS:0, origE:11, normS:0, normE:11} for 'hello\n' (10 chars + newline)
            // and norm range is 0-5 ('hello'), we want orig range 0-5.
            // startEntry = entry, endEntry = entry. origStart = 0, origEnd = 11. Incorrect.

            // --- Refined Logic ---
            // Calculate char offset within the normalized start entry
            const normOffsetInStartEntry = normalizedStart - startEntry.normalizedStart;
            // Calculate char offset within the normalized end entry for the end point
            const normOffsetInEndEntry = (normalizedEnd) - endEntry.normalizedStart; // Use exclusive end

            // TODO: Need a way to map normalized offset within an entry back to original offset within that entry.
            // This requires more sophisticated mapping than line-level.
            // Using the entry boundaries is an approximation.
            originalEnd = endEntry.originalEnd; // Use the full original range of the end entry for now.

            // Ensure start <= end. Can happen if end maps to an earlier original line.
            if (originalEnd < originalStart) {
                console.warn(`Potential mapping issue: Original end (${originalEnd}) is before original start (${originalStart}). Using start entry's end.`);
                originalEnd = startEntry.originalEnd; // Fallback to start entry's end
            }

        } else if (originalEnd < originalStart) {
            // Handle cases where the calculated end is before start due to mapping anomalies
            console.warn(`Mapped original end (${originalEnd}) is before start (${originalStart}). Clamping end to start.`);
            originalEnd = originalStart;
        }


        return {originalStart: originalStart, originalEnd: originalEnd};
    }

    console.warn("Could not translate normalized range accurately using current mapping:", normalizedStart, normalizedEnd);
    return null; // Indicate translation failure
}

// --- Fuzzy Matching ---

/**
 * Finds occurrences of a pattern within a text using fuzzy matching.
 * Uses a simple sliding window and string-similarity comparison.
 *
 * @param textToSearch The text to search within.
 * @param pattern The pattern to search for.
 * @param threshold The minimum similarity score (0.0 to 1.0) required for a match.
 * @returns An array of matches, each with start/end offsets and similarity score.
 */
export function findFuzzyMatches(
    textToSearch: string,
    pattern: string,
    threshold: number
): Array<{ start: number; end: number; similarity: number }> {
    const matches: Array<{ start: number; end: number; similarity: number }> = [];
    // Normalize line endings in both texts before comparing for consistency
    const normalizedText = normalizeLineEndings(textToSearch);
    const normalizedPattern = normalizeLineEndings(pattern);
    const patternLength = normalizedPattern.length;
    const textLength = normalizedText.length;

    if (patternLength === 0 || textLength < patternLength) {
        return matches; // Cannot match empty or longer pattern
    }

    // Sliding window approach
    for (let i = 0; i <= textLength - patternLength; i++) {
        const substring = normalizedText.substring(i, i + patternLength);
        const similarity = compareTwoStrings(normalizedPattern, substring);

        if (similarity >= threshold) {
            // Check for significant overlap with the previously added match
            const lastMatch = matches[matches.length - 1];
            // Add if no previous match OR current match starts at or after the end of the last match
            // This prevents adding matches that are essentially the same region shifted by one character.
            if (!lastMatch || i >= lastMatch.end) {
                matches.push({start: i, end: i + patternLength, similarity});
            } else {
                // Optional: Handle overlap more gracefully, e.g., replace last match if current one is better?
                // if (similarity > lastMatch.similarity) {
                //   matches[matches.length - 1] = { start: i, end: i + patternLength, similarity };
                // }
                // console.error(`Skipping overlapping match at index ${i} (Similarity: ${similarity.toFixed(2)})`);
            }
        }
    }

    return matches;
}

// --- Context Extraction ---

/**
 * Extracts lines of context around a given character offset range in a string.
 *
 * @param content The full text content.
 * @param startOffset The starting character offset of the region of interest.
 * @param endOffset The exclusive ending character offset of the region of interest.
 * @param numContextLines The number of lines to include before and after the region.
 * @returns A string containing the context lines, including the lines within the range.
 */
export function extractContextLines(
    content: string,
    startOffset: number,
    endOffset: number,
    numContextLines: number = 3
): string {
    const lines = normalizeLineEndings(content).split('\n');
    let startLine = -1;
    let endLine = -1;
    let charCount = 0;

    // Clamp offsets to valid range
    startOffset = Math.max(0, Math.min(startOffset, content.length));
    endOffset = Math.max(startOffset, Math.min(endOffset, content.length));


    // Find start and end line numbers corresponding to the offsets
    for (let i = 0; i < lines.length; i++) {
        const lineLengthWithNewline = lines[i].length + 1; // +1 for the newline character
        const lineStartOffset = charCount;
        const lineEndOffset = charCount + lineLengthWithNewline;

        // Check if startOffset falls within this line
        if (startLine === -1 && startOffset < lineEndOffset) {
            // Special case: if startOffset is exactly at the beginning of the line after the newline
            if (startOffset === lineStartOffset && i > 0 && content[startOffset - 1] === '\n') {
                startLine = i;
            }
            // General case: startOffset is somewhere within this line's content or its newline
            else if (startOffset >= lineStartOffset) {
                startLine = i;
            }
        }

        // Check if endOffset falls within this line or marks the end of it
        // Use exclusive endOffset comparison
        if (endLine === -1 && endOffset <= lineEndOffset) {
            // If endOffset is exactly start of line, the range ended *before* this line
            if (endOffset === lineStartOffset && i > 0) {
                endLine = i - 1;
            } else {
                endLine = i;
            }
        }

        charCount = lineEndOffset; // Move to the start of the next line

        // Optimization: Stop if both are found
        // Need to continue if endLine isn't found yet, even if startLine is.
        // Stop only if startLine is found AND endOffset is definitively passed.
        if (startLine !== -1 && endOffset <= lineStartOffset) {
            // If end wasn't found yet, it must have been the previous line
            if (endLine === -1) endLine = i - 1;
            break;
        }
    }

    // Handle cases where offsets might be beyond content length or range ends at EOF
    if (startLine === -1 && startOffset >= content.length) startLine = lines.length - 1; // If start is at/after EOF
    if (startLine === -1) startLine = 0; // Default to first line if not found (e.g., offset 0)
    if (endLine === -1) endLine = lines.length - 1; // Default to last line if not found

    // Ensure endLine is not before startLine
    endLine = Math.max(startLine, endLine);


    // Calculate context boundaries
    const contextStartLine = Math.max(0, startLine - numContextLines);
    const contextEndLine = Math.min(lines.length, endLine + numContextLines + 1); // Exclusive end index for slice

    // Extract and join lines
    return lines.slice(contextStartLine, contextEndLine).join('\n');
}


// --- Legacy applyFileEdits Function ---

/**
 * Legacy function to apply edits using 'exact' or 'structure' mode.
 * Note: The 'smart' mode implementation is now primarily within index.ts using the newer helpers.
 * This function is retained for potential compatibility or reference.
 *
 * @param filePath Path to the file.
 * @param edits Array of edit objects ({oldText, newText}).
 * @param dryRun If true, returns diff without modifying file.
 * @param mode Matching mode ('exact', 'structure'). 'semantic' behaves like 'structure'.
 * @param formatAfter If true, format after editing.
 * @param includeContext If true, include context in dry run diff.
 * @returns A status message or diff string.
 */
export async function applyFileEdits(
    filePath: string,
    edits: Array<{ oldText: string, newText: string }>,
    dryRun = false,
    mode = 'exact',
    formatAfter = false,
    includeContext = true
): Promise<string> {
    console.warn("Executing LEGACY applyFileEdits function. Consider using the 'smart' mode via the main tool handler.");
    // Read file content and normalize line endings
    const originalContent = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    const language = detectLanguage(filePath);
    let modifiedContent = originalContent;
    const appliedEditsInfo: Array<{
        match: string,
        replacement: string,
        location: { line: number, column: number }
    }> = [];
    let matchOccurred = false; // Track if any replacement happened

    for (const edit of edits) {
        const normalizedOld = normalizeLineEndings(edit.oldText);
        const normalizedNew = normalizeLineEndings(edit.newText);
        let currentMatchFound = false;

        // --- Attempt replacement based on mode ---
        if (mode === 'exact') {
            if (modifiedContent.includes(normalizedOld)) {
                // Simple exact replacement
                modifiedContent = modifiedContent.replaceAll(normalizedOld, normalizedNew); // Use replaceAll for multiple occurrences
                currentMatchFound = true; // Assume match if includes passes, though replaceAll might not replace if context changed between loops
                matchOccurred = true;
                // Note: Tracking exact location for multiple replacements is hard here.
            }
        } else { // structure or semantic (treated similarly here)
            const contentForMatching = normalizeCodeForMatching(modifiedContent, mode); // Legacy call
            const searchTextForMatching = normalizeCodeForMatching(normalizedOld, mode); // Legacy call

            if (searchTextForMatching && contentForMatching.includes(searchTextForMatching)) {
                // This part is complex and was approximate in the original.
                // A simple replace might corrupt structure if normalization was lossy.
                // For simplicity in this legacy function, let's just do a basic replace
                // on the original content if the normalized versions match. This is UNSAFE.
                console.warn(`Legacy structural edit attempted for "${edit.oldText.substring(0, 30)}...". Using potentially unsafe direct replacement.`);
                if (modifiedContent.includes(normalizedOld)) { // Fallback to exact match within original if possible
                    modifiedContent = modifiedContent.replaceAll(normalizedOld, normalizedNew);
                    currentMatchFound = true;
                    matchOccurred = true;
                } else {
                    console.warn("Normalized match found, but original text not present. Skipping potentially unsafe structural replacement in legacy function.");
                    // Cannot safely replace based only on normalized match without proper mapping.
                }
            }
        }

        if (!currentMatchFound && modifiedContent.includes(normalizedOld)) {
            // If mode was structure but normalized match failed, maybe exact match still works?
            modifiedContent = modifiedContent.replaceAll(normalizedOld, normalizedNew);
            currentMatchFound = true;
            matchOccurred = true;
        }

        if (!currentMatchFound) {
            // If still no match after trying mode-specific and exact, throw error
            // Avoid throwing if at least one previous edit *did* succeed.
            if (edits.length === 1 || !matchOccurred) {
                throw new Error(`Legacy applyFileEdits: Could not find matching content for edit in mode '${mode}':\n${edit.oldText}`);
            } else {
                console.warn(`Legacy applyFileEdits: Could not find match for subsequent edit in mode '${mode}'. Previous edits applied.`);
                // Continue processing other edits if possible
            }
        }
    } // End loop

    // --- Post-processing ---
    let finalContent = modifiedContent;
    if (!dryRun && formatAfter && language) {
        try {
            console.error(`Formatting ${language} code (legacy)...`);
            finalContent = await formatCode(finalContent, language, filePath);
        } catch (error) {
            console.error(`Formatting failed (legacy):`, error);
            // Continue with unformatted content
        }
    }

    const diff = createUnifiedDiff(originalContent, finalContent, filePath);

    // --- Generate Response ---
    let response = '';
    if (dryRun) {
        response = `LEGACY DRY RUN - Edit Preview for ${filePath}\n(Note: Location info not available in legacy dry run)\n\n`;
        let numBackticks = 3;
        while (diff.includes('`'.repeat(numBackticks))) {
            numBackticks++;
        }
        response += `${'`'.repeat(numBackticks)}diff\n${diff}\n${'`'.repeat(numBackticks)}\n\n`;
        response += `DRY RUN ONLY - No changes written.`;
        if (formatAfter && language) response += ` (Would format with ${language} formatter)`;
    } else {
        await fs.writeFile(filePath, finalContent, 'utf-8');
        response = `Legacy applyFileEdits: Applied changes to ${filePath}`;
        if (formatAfter && language) response += ` and formatted with ${language}`;
        if (!matchOccurred) response += " (Warning: Some edits might not have found a match).";
    }

    return response;
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
export async function applySmartEdits(
    filePath: string,
    edits: Array<{ oldText: string, newText: string }>,
    // Receive the full options object, rely on defaults defined in the schema if not provided
    normalizationOptions: NormalizationOptions,
    similarityThreshold: number, // Expect this to be passed, default handled by schema
    disambiguationIndex?: number,
    dryRun = false,
    formatAfter = false
): Promise<string | any> { // Return object for ambiguous/dry run

    const originalContent = await fs.readFile(filePath, 'utf-8');
    let currentContent = originalContent; // Start with original, mutate this variable
    const appliedEditsInfoAccumulator: any[] = [];
    let ambiguityRequiresRetry = false;

    // --- Process Edits Sequentially ---
    for (let editIndex = 0; editIndex < edits.length; editIndex++) {
        const edit = edits[editIndex];
        const isLastEdit = editIndex === edits.length - 1; // Flag for logging/debugging

        console.error(`--- Processing Edit ${editIndex + 1}/${edits.length} ---`);

        if (!edit.oldText) {
            console.error(`Edit ${editIndex + 1}: oldText is empty. Skipping.`);
            continue;
        }

        // --- Determine Normalization for *this* pattern search ---
        // Default to the passed options, but allow override for markers
        let currentSearchNormOptions = {...normalizationOptions}; // Clone options
        const isMarkerSearch = edit.oldText.includes("__MCP_SMART_EDIT_INSERT_POINT__"); // Check if searching for marker

        if (isMarkerSearch) {
            // When searching FOR the marker, ensure it's not removed by normalization
            console.error(`Edit ${editIndex + 1}: Marker search detected. Adjusting normalization (keeping internal whitespace, sensitive case).`);
            currentSearchNormOptions.ignoreInternalWhitespace = 'keep'; // Keep whitespace around marker
            currentSearchNormOptions.caseSensitive = true; // Markers are case-sensitive
            // Keep other options like ignoreComments, ignoreBlankLines etc. as they likely won't affect the marker itself
            // unless the marker was inserted inside comments or on blank lines.
        }

        // --- Normalize the CURRENT file content ---
        // Use the standard normalizationOptions here, as we need the mapping based on general rules
        const normResultCurrentFile = normalizeCodeForMatching(currentContent, normalizationOptions);
        if (typeof normResultCurrentFile === 'string' || !normResultCurrentFile || !normResultCurrentFile.normalizedText || !normResultCurrentFile.mapping) {
            throw new Error(`Internal Error: Normalization of current file content failed for edit ${editIndex + 1}.`);
        }
        const currentNormalizedFileContent = normResultCurrentFile.normalizedText;
        const currentFileMapping = normResultCurrentFile.mapping;

        // --- Normalize the search pattern using potentially adjusted options ---
        const normResultPattern = normalizeCodeForMatching(edit.oldText, currentSearchNormOptions); // Use adjusted options
        if (typeof normResultPattern === 'string' || !normResultPattern || !normResultPattern.normalizedText) {
            console.error(`Edit ${editIndex + 1}: Normalization of oldText pattern failed. Skipping.`);
            continue;
        }
        const normalizedSearchPattern = normResultPattern.normalizedText;


        if (!normalizedSearchPattern) {
            // This can happen if oldText was JUST comments/whitespace and ignore options are true
            console.error(`Edit ${editIndex + 1}: Normalized search pattern is empty. Skipping.`);
            continue;
        }

        console.error(`Edit ${editIndex + 1}: Searching for normalized pattern: "${normalizedSearchPattern.substring(0, 70)}..."`);
        // Debug: Log snippet of where it's searching
        // console.error("DEBUG: Searching within normalized content snippet:\n", currentNormalizedFileContent.substring(0, 500));

        const matches = findFuzzyMatches(
            currentNormalizedFileContent,
            normalizedSearchPattern,
            // Use lower threshold for markers maybe? Or stick to exact? Let's keep exact for now.
            isMarkerSearch ? 1.0 : similarityThreshold
        );

        console.error(`Edit ${editIndex + 1}: Found ${matches.length} match(es).`); // Log match count

        let chosenMatch: { start: number; end: number; similarity: number } | null = null;
        let matchIndexUsed: number | undefined = undefined;

        // --- Logic for choosing match or detecting ambiguity ---
        if (matches.length === 0) {
            // Log more context on failure
            console.error("DEBUG: Failed Search Details:");
            console.error(`  - Normalized Pattern Searched: "${normalizedSearchPattern}"`);
            console.error(`  - In Normalized Content (first 500 chars):\n"${currentNormalizedFileContent.substring(0, 500)}"`);
            console.error("  - Using Normalization Options:", JSON.stringify(currentSearchNormOptions)); // Log options used for *this* search
            throw new Error(`Edit ${editIndex + 1}: Pattern not found for oldText: "${edit.oldText.substring(0, 50)}..." (Similarity: ${isMarkerSearch ? '1.0 (marker)' : similarityThreshold}, Normalized)`);
        } else if (matches.length === 1) {
            chosenMatch = matches[0];
            matchIndexUsed = 0;
            if (disambiguationIndex && editIndex === 0) {
                console.error(`Edit ${editIndex + 1}: Disambiguation index ${disambiguationIndex} provided, but only one match found. Using the single match.`);
            }
            ambiguityRequiresRetry = false; // Not ambiguous
        } else { // matches.length > 1
            if (disambiguationIndex && editIndex === 0) {
                if (disambiguationIndex > 0 && disambiguationIndex <= matches.length) {
                    chosenMatch = matches[disambiguationIndex - 1];
                    matchIndexUsed = disambiguationIndex - 1;
                    console.error(`Using disambiguation index ${disambiguationIndex} (0-based: ${matchIndexUsed}) for edit ${editIndex + 1}.`);
                    ambiguityRequiresRetry = false; // Resolved
                } else {
                    throw new Error(`Edit ${editIndex + 1}: Invalid disambiguation index ${disambiguationIndex}. Found ${matches.length} matches this time.`);
                }
            } else {
                // MULTIPLE MATCHES + (NO INDEX OR NOT FIRST EDIT) -> AMBIGUOUS
                ambiguityRequiresRetry = true;
                console.error(`Ambiguity detected for edit ${editIndex + 1}, preparing context...`);
                const ambiguousMatchesContextLocal: Array<{
                    index: number;
                    originalLocation: { start: number; end: number };
                    context: string
                }> = [];
                for (let i = 0; i < matches.length; i++) {
                    const match = matches[i];
                    // Translate range based on the *current* mapping
                    const originalRange = translateNormalizedRangeToOriginal(match.start, match.end, currentFileMapping); // Use CURRENT mapping
                    if (originalRange) {
                        // Extract context from *currentContent* state
                        const context = extractContextLines(currentContent, originalRange.originalStart, originalRange.originalEnd); // Use CURRENT content
                        ambiguousMatchesContextLocal.push({
                            index: i + 1,
                            originalLocation: {start: originalRange.originalStart, end: originalRange.originalEnd},
                            context
                        });
                    } else { /* handle mapping failure */
                        ambiguousMatchesContextLocal.push({
                            index: i + 1,
                            originalLocation: {start: -1, end: -1},
                            context: "[Mapping Failed]"
                        });
                    }
                }
                // Return immediately for ambiguity
                return {
                    status: "AMBIGUOUS",
                    message: `Multiple potential matches found for edit ${editIndex + 1}. Please specify the index (1-based) in 'disambiguationIndex' on your next request for this specific edit.`,
                    editIndex: editIndex + 1, // Inform AI which edit was ambiguous
                    matches: ambiguousMatchesContextLocal,
                };
            }
        }

        // --- Apply the chosen edit immediately to currentContent ---
        if (chosenMatch) {
            // Translate chosen match range based on the mapping used for *this* search
            const originalRange = translateNormalizedRangeToOriginal(chosenMatch.start, chosenMatch.end, currentFileMapping); // Use CURRENT mapping
            if (!originalRange) {
                throw new Error(`Edit ${editIndex + 1}: Failed to map chosen match back to current content location.`);
            }

            // Store info for dry run *before* modifying content
            appliedEditsInfoAccumulator.push({
                editIndex: editIndex + 1,
                originalRange: {start: originalRange.originalStart, end: originalRange.originalEnd},
                newTextLength: edit.newText.length,
                similarity: chosenMatch.similarity,
                matchIndexUsed: matchIndexUsed
            });

            // Apply replacement to currentContent
            const safeStart = Math.min(originalRange.originalStart, currentContent.length);
            const safeEnd = Math.min(originalRange.originalEnd, currentContent.length);

            if (safeEnd < safeStart) {
                console.error(`Warning: Attempting to apply edit ${editIndex + 1} with end (${safeEnd}) before start (${safeStart}). Skipping this edit.`);
            } else {
                console.error(`Applying Edit ${editIndex + 1}: Replacing range ${safeStart}-${safeEnd} in current content.`);
                currentContent =
                    currentContent.slice(0, safeStart) +
                    edit.newText +
                    currentContent.slice(safeEnd);
                // console.error(`DEBUG: Content after edit ${editIndex + 1}:\n${currentContent.substring(0,500)}`); // Debug log
            }
        } else {
            // This should only be reachable if ambiguity occurred but wasn't returned (logic error)
            throw new Error(`Internal error in edit ${editIndex + 1}: No match chosen but ambiguity not returned.`);
        }
    } // --- End loop through edits ---

    // --- If loop completes without returning AMBIGUOUS ---

    // Check consistency (optional)
    const finalValidEditsCount = edits.filter(e => e.oldText && normalizeCodeForMatching(e.oldText, normalizationOptions).normalizedText).length;
    if (appliedEditsInfoAccumulator.length !== finalValidEditsCount) {
        console.error(`Warning: Applied ${appliedEditsInfoAccumulator.length} edits, but expected ${finalValidEditsCount} valid edits. Some may have been skipped.`);
    }
    if (appliedEditsInfoAccumulator.length === 0) {
        if (edits.length > 0) { // If there were edits requested but none applied
            throw new Error("No valid edits could be applied (check patterns and normalization settings).");
        }
        return "No valid edits were specified.";
    }

    // --- Stage 4: Handle dryRun ---
    if (dryRun) {
        // Diff is between original and the final currentContent
        const diff = createUnifiedDiff(originalContent, currentContent, filePath);
        return {
            status: "DRY_RUN_SUCCESS",
            message: "Dry run successful. Changes calculated.",
            diff: diff,
            // Report based on accumulated successful applications
            appliedEditsInfo: appliedEditsInfoAccumulator.sort((a, b) => a.editIndex - b.editIndex) // Sort by original edit index
        };
    }

    // --- Stage 5: Format (if requested) ---
    let finalContentToWrite = currentContent; // Start with the final edited content
    if (formatAfter) {
        const language = detectLanguage(filePath);
        if (language) {
            try {
                console.error(`Formatting code for language: ${language}`);
                finalContentToWrite = await formatCode(finalContentToWrite, language, filePath);
                console.error("Formatting successful.");
            } catch (formatError: any) {
                console.error(`Formatting failed: ${formatError.message}. Proceeding with unformatted content.`);
            }
        } else {
            console.error(`Cannot format file: Language not detected for ${filePath}`);
        }
    }


    // --- Stage 6: Write File (NO GIT) ---
    try {
        await fs.writeFile(filePath, finalContentToWrite, 'utf-8');
        console.error(`File written successfully: ${filePath}`);

        // Diff is between original and the finalContentToWrite
        const diff = createUnifiedDiff(originalContent, finalContentToWrite, filePath);

        // --- Construct success message ---
        let successMessage = `File '${filePath}' edited successfully via smart mode`;
        if (formatAfter) {
            successMessage += ` and formatted`;
        }

        // --- Return success message string ---
        return {
            status: "SUCCESS",
            message: successMessage,
            diff: diff,
            // Report based on accumulated successful applications
            appliedEditsInfo: appliedEditsInfoAccumulator.sort((a, b) => a.editIndex - b.editIndex) // Sort by original edit index
        };

    } catch (writeError: any) {
        // Throw error if writing fails
        throw new Error(`Failed to write file "${filePath}": ${writeError.message}`);
    }
} // --- End of applySmartEdits ---