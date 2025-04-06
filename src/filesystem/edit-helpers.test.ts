import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { normalizeLineEndings, detectLanguage, normalizeCodeForMatching, applyFileEdits } from './edit-helpers.js';

// Create a temporary directory for file operations
let tempDir: string;

beforeAll(async () => {
  tempDir = path.join(os.tmpdir(), `edit-helper-tests-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
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

  describe('applyFileEdits', () => {
    it('applies exact text replacement', async () => {
      const filepath = await createTestFile('Hello world');
      await applyFileEdits(filepath, [
        { oldText: 'world', newText: 'universe' }
      ], false, 'exact');
      
      const content = await fs.readFile(filepath, 'utf-8');
      expect(content).toBe('Hello universe');
    });

    it('applies multiple edits in sequence', async () => {
      const filepath = await createTestFile('The quick brown fox jumps over the lazy dog');
      await applyFileEdits(filepath, [
        { oldText: 'quick', newText: 'speedy' },
        { oldText: 'lazy', newText: 'sleeping' }
      ], false, 'exact');
      
      const content = await fs.readFile(filepath, 'utf-8');
      expect(content).toBe('The speedy brown fox jumps over the sleeping dog');
    });

    it('applies edits in structure mode ignoring whitespace', async () => {
      const code = 'function test() {\n  console.log("test");\n}';
      const filepath = await createTestFile(code, 'test.js');
      
      await applyFileEdits(filepath, [
        { 
          oldText: 'function test() {\nconsole.log("test");\n}', 
          newText: 'function test() {\n  console.log("modified");\n}' 
        }
      ], false, 'structure');
      
      const content = await fs.readFile(filepath, 'utf-8');
      expect(content).toContain('console.log("modified")');
    });

    it('generates detailed diff output in dry run mode', async () => {
      const filepath = await createTestFile('Hello world');
      const result = await applyFileEdits(filepath, [
        { oldText: 'world', newText: 'universe' }
      ], true, 'exact');
      
      // Original content should remain unchanged
      const content = await fs.readFile(filepath, 'utf-8');
      expect(content).toBe('Hello world');
      
      // Result should contain the diff
      expect(result).toContain('diff');
      expect(result).toContain('-Hello world');
      expect(result).toContain('+Hello universe');
      expect(result).toContain('DRY RUN ONLY');
    });
  });
});
