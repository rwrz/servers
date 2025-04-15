import {describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll} from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    normalizeLineEndings,
    detectLanguage,
    normalizeCodeForMatching,
    applyFileEdits,
    applySmartEdits,
    NormalizationOptions, NormalizationResult
} from './edit-helpers.js';
//import { applySmartEdits, NormalizationOptions } from './edit-helpers'; // Import the function

//
//
// // Example using Vitest in e.g., edit-helpers.test.ts
// import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// import fs from 'fs/promises';
// import path from 'path';
// import os from 'os';
// import { applySmartEdits, NormalizationOptions } from './edit-helpers'; // Import the function


// Create a temporary directory for file operations
let tempDir: string;

beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `edit-helper-tests-${Date.now()}`);
    await fs.mkdir(tempDir, {recursive: true});
});

afterAll(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
});

describe('edit-helpers', () => {
    // Helper to create a test file with content
    async function createTestFile(content: string, filename = 'test.txt'): Promise<string> {
        const filepath = path.join(tempDir, filename);
        await fs.writeFile(filepath, content, 'utf-8');
        return filepath;
    }

    describe('normalizeLineEndings', () => {
        it('converts CRLF to LF', () => {
            const text = 'line1\r\nline2\r\nline3';
            expect(normalizeLineEndings(text)).toBe('line1\nline2\nline3');
        });

        it('converts CR to LF', () => {
            const text = 'line1\rline2\rline3';
            expect(normalizeLineEndings(text)).toBe('line1\nline2\nline3');
        });

        it('leaves LF unchanged', () => {
            const text = 'line1\nline2\nline3';
            expect(normalizeLineEndings(text)).toBe('line1\nline2\nline3');
        });

        it('handles mixed line endings', () => {
            const text = 'line1\nline2\r\nline3\rline4';
            expect(normalizeLineEndings(text)).toBe('line1\nline2\nline3\nline4');
        });
    });

    describe('detectLanguage', () => {
        it('detects language from file extension', () => {
            expect(detectLanguage('file.js')).toBe('javascript');
            expect(detectLanguage('file.ts')).toBe('typescript');
            expect(detectLanguage('file.dart')).toBe('dart');
            expect(detectLanguage('file.go')).toBe('go');
            expect(detectLanguage('file.py')).toBe('python');
            expect(detectLanguage('file.txt')).toBe(null);
        });

        it('handles uppercase extensions', () => {
            expect(detectLanguage('file.JS')).toBe('javascript');
            expect(detectLanguage('file.TS')).toBe('typescript');
            expect(detectLanguage('file.DART')).toBe('dart');
        });
    });

    describe('normalizeCodeForMatching', () => {
        it('normalizes code with options and returns mapping', () => {
            const code = 'function test() {\n  // A comment\n  const x = 1; /* Multi\nLine */\n\n return x;\n}';
            const options: NormalizationOptions = {
                ignoreComments: true,
                ignoreLeadingWhitespace: true,
                ignoreTrailingWhitespace: true,
                ignoreInternalWhitespace: "collapse",
                ignoreBlankLines: true,
                caseSensitive: true
            };
            const result = normalizeCodeForMatching(code, options) as NormalizationResult;
            // --- ADJUSTED Expected Result ---
            // With improved comment/whitespace/blank line removal:
            expect(result.normalizedText).toBe('function test() {\nconst x = 1;\nreturn x;\n}');
            //                                  ^-- Note: leading space preserved if not trimmed by 'collapse' on first token
            //                                      ^-- Blank line removed
            // Let's refine expectation based on 'collapse' which adds a space
            // expect(result.normalizedText).toBe('function test() {\n const x = 1;\n return x;\n}\n'); // Might be too strict
            expect(result.normalizedText).toMatch(/function test\(\) \{/);
            expect(result.normalizedText).toMatch(/const x = 1;/);
            expect(result.normalizedText).toMatch(/return x;/);
            expect(result.normalizedText).toMatch(/\}/);
            expect(result.normalizedText).not.toContain('/*');
            expect(result.normalizedText).not.toContain('//');
            // Check blank line removal by counting lines
            expect(result.normalizedText.split('\n').filter(l => l.trim() !== '').length).toBe(4); // function {, const, return, }
            // checking mapping
            expect(result).toHaveProperty('normalizedText');
            expect(result).toHaveProperty('mapping');
            expect(result.mapping.length).toBeGreaterThan(0); // Check mapping exists
        });

        it('keeps text unchanged in exact mode', () => {
            const code = 'function test() {\n  // A comment\n  return true;\n}';
            expect(normalizeCodeForMatching(code, 'exact')).toBe(code);
        });

        it('removes comments in structure and semantic modes', () => {
            const code = 'function test() {\n  // A comment\n  return true;\n}';
            const result = normalizeCodeForMatching(code, 'structure');
            expect(result).not.toContain('// A comment');
        });

        it('handles multi-line comments', () => {
            const code = 'function test() {\n  /* This is\n  a multi-line\n  comment */\n  return true;\n}';
            const result = normalizeCodeForMatching(code, 'structure');
            expect(result).not.toContain('multi-line');
        });
    });

    describe('applySmartEdits', () => {
        let testFilePath: string;
        const originalFileContent = `
// File start
async function validatePath(requestedPath: string): Promise<string> {
  // Original validatePath body
  console.log('validate');
}
// Spacer comment
function normalizePath(p: string): string {
  // Original normalizePath body
  return p.trim();
}
// Another comment
const EditFileArgsSchema = z.object({
    path: z.string(),
    mode: z.enum(["smart", "patch"]), // Existing field
});
// File end
`;

        beforeEach(async () => {
            testFilePath = await createTestFile(originalFileContent, `smart-edit-test-${Date.now()}.ts`);
        });

        it('should rename functions and add field using smart mode (dryRun)', async () => {
            const testEdits = [
                { // Rename validatePath
                    oldText: "async function validatePath(requestedPath: string): Promise<string> {",
                    newText: "async function verifyPath(requestedPath: string): Promise<string> {"
                },
                { // Rename normalizePath
                    oldText: "function normalizePath(p: string): string {",
                    newText: "function normalizePath(p: string, strict: boolean = false): string {"
                },
                { // Step 1: Add non-comment marker
                    oldText: "const EditFileArgsSchema = z.object({",
                    // Append the marker after the brace and a newline
                    newText: "const EditFileArgsSchema = z.object({\n__MCP_SMART_EDIT_INSERT_POINT__"
                },
                { // Step 2: Replace marker
                    oldText: "__MCP_SMART_EDIT_INSERT_POINT__", // Search for the non-comment marker
                    // Replace with the new field, ensuring correct indentation
                    newText: "  enableLogging: z.boolean().optional().default(false).describe(\"If true, enables logging of operations. Default: false\"),"
                }
            ];
            const testNormOptions: NormalizationOptions = {
                ignoreComments: true,
                ignoreLeadingWhitespace: true,
                ignoreTrailingWhitespace: true,
                ignoreInternalWhitespace: "collapse",
                ignoreBlankLines: true,
                caseSensitive: true
            };

            const result = await applySmartEdits(
                testFilePath,
                testEdits,
                testNormOptions,
                1.0,
                undefined,
                true, // dryRun = true
                false
            );

            // Check the overall structure and status
            expect(result).toBeTypeOf('object');
            expect(result).toHaveProperty('status', 'DRY_RUN_SUCCESS');
            expect(result).toHaveProperty('diff');
            expect(result.diff).toBeTypeOf('string');

            // Check function renames (these should still be correct)
            expect(result.diff).toContain('-async function validatePath');
            expect(result.diff).toContain('+async function verifyPath');
            expect(result.diff).toContain('-function normalizePath(p: string): string {');
            expect(result.diff).toContain('+function normalizePath(p: string, strict: boolean = false): string {');

            // --- ADJUSTED ASSERTIONS for the insertion ---
            // 1. Check that the *new* line was added correctly
            expect(result.diff).toContain('+  enableLogging: z.boolean().optional().default(false)');

            // 2. Check that the original line *still exists* in some form in the diff
            //    (likely as context or part of the change chunk header, NOT prefixed with '-')
            expect(result.diff).toContain('const EditFileArgsSchema = z.object({');

            // 3. Check that the original line was *NOT* marked as purely deleted
            expect(result.diff).not.toContain('-const EditFileArgsSchema = z.object({');
            // --- End Adjusted Assertions ---

            // Check appliedEditsInfo
            expect(result).toHaveProperty('appliedEditsInfo');
            expect(result.appliedEditsInfo).toBeInstanceOf(Array);
            expect(result.appliedEditsInfo.length).toBe(testEdits.length);
        });

        // Keep the non-dryRun test (it checks final content, which should be correct)
        it('should apply changes correctly when not dryRun', async () => {
            const testEdits = [
                { // Rename validatePath
                    oldText: "async function validatePath(requestedPath: string): Promise<string> {",
                    newText: "async function verifyPath(requestedPath: string): Promise<string> {"
                },
                { // Rename normalizePath
                    oldText: "function normalizePath(p: string): string {",
                    newText: "function normalizePath(p: string, strict: boolean = false): string {"
                },
                { // Step 1: Add non-comment marker
                    oldText: "const EditFileArgsSchema = z.object({",
                    // Append the marker after the brace and a newline
                    newText: "const EditFileArgsSchema = z.object({\n__MCP_SMART_EDIT_INSERT_POINT__"
                },
                { // Step 2: Replace marker
                    oldText: "__MCP_SMART_EDIT_INSERT_POINT__", // Search for the non-comment marker
                    // Replace with the new field, ensuring correct indentation
                    newText: "  enableLogging: z.boolean().optional().default(false).describe(\"If true, enables logging of operations. Default: false\"),"
                }
            ];
            const testNormOptions: NormalizationOptions = {
                ignoreComments: true,
                ignoreLeadingWhitespace: true,
                ignoreTrailingWhitespace: true,
                ignoreInternalWhitespace: "collapse",
                ignoreBlankLines: true,
                caseSensitive: true,
            };

            const result = await applySmartEdits(
                testFilePath,
                testEdits,
                testNormOptions,
                1.0,
                undefined,
                false, // dryRun = false
                false
            );

            expect(result).toBeTypeOf('object');
            expect(result).toHaveProperty('status', 'SUCCESS');
            expect(result).toHaveProperty('diff');
            expect(result.diff).toBeTypeOf('string');

            const modifiedContent = await fs.readFile(testFilePath, 'utf-8');
            expect(modifiedContent).toContain('async function verifyPath');
            expect(modifiedContent).toContain('function normalizePath(p: string, strict: boolean = false)');
            expect(modifiedContent).toMatch(/const EditFileArgsSchema = z\.object\({[^}]+enableLogging:[^}]+path: z\.string\(\),/s);
            expect(modifiedContent).not.toContain('async function validatePath');
            expect(modifiedContent).not.toContain('function normalizePath(p: string): string {');
            expect(modifiedContent).not.toContain('__MCP_SMART_EDIT_INSERT_POINT__');
        });

        // Add more tests:
        // - Test with similarityThreshold < 1.0
        // - Test ambiguity and disambiguationIndex
        // - Test different normalization options
        // - Test edits near beginning/end of file
        // - Test formatAfter=true (might require mocking formatters or having them installed)

    });

});
