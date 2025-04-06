import fs from 'fs/promises';
import path from 'path';
import { diffLines, createTwoFilesPatch } from 'diff';
import { formatCode } from './formatters.js';

/**
 * Normalizes line endings to LF format
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Creates a unified diff between two text contents
 */
export function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

/**
 * Detects programming language from file extension
 */
export function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    '.js': 'javascript',
    '.ts': 'typescript',
    '.jsx': 'javascript',
    '.tsx': 'typescript',
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
  };
  
  return languageMap[ext] || null;
}

/**
 * Normalizes code for matching based on the specified mode
 */
export function normalizeCodeForMatching(text: string, mode: string): string {
  if (mode === 'exact') return text;
  
  let normalized = text;
  
  if (mode === 'structure' || mode === 'semantic') {
    // Remove single-line comments
    normalized = normalized.replace(/\/\/.*$/gm, '');
    // Remove multi-line comments
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
    
    if (mode === 'structure') {
      // Standardize whitespace but preserve line structure
      normalized = normalized.split('\n')
        .map(line => line.trim())
        .join('\n');
    }
  }
  
  return normalized;
}

/**
 * Apply edits to a file with various matching strategies
 */
export async function applyFileEdits(
  filePath: string,
  edits: Array<{oldText: string, newText: string}>,
  dryRun = false,
  mode = 'exact',
  formatAfter = false,
  includeContext = true
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
  
  // Detect language for potential formatting
  const language = detectLanguage(filePath);
  
  // Store original line breaks for preservation
  const lineBreakMatch = content.match(/\r\n|\r|\n/);
  const lineBreak = lineBreakMatch ? lineBreakMatch[0] : '\n';
  
  // Apply edits sequentially
  let modifiedContent = content;
  const appliedEdits: Array<{
    match: string,
    replacement: string,
    location: {line: number, column: number}
  }> = [];
  
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);
    
    // Try exact match first
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      
      // Track this edit for reporting
      const beforeMatch = modifiedContent.substring(0, modifiedContent.indexOf(normalizedNew));
      const lineNumber = beforeMatch.split('\n').length;
      const lastNewline = beforeMatch.lastIndexOf('\n');
      const column = lastNewline === -1 ? beforeMatch.length + 1 : beforeMatch.length - lastNewline;
      
      appliedEdits.push({
        match: normalizedOld,
        replacement: normalizedNew,
        location: { line: lineNumber, column }
      });
      
      continue;
    }
    
    // If exact match fails and we're in structure or semantic mode
    if (mode !== 'exact') {
      const contentForMatching = normalizeCodeForMatching(modifiedContent, mode);
      const searchTextForMatching = normalizeCodeForMatching(normalizedOld, mode);
      
      if (contentForMatching.includes(searchTextForMatching)) {
        // Find the match position in the normalized content
        const matchPosition = contentForMatching.indexOf(searchTextForMatching);
        
        // Calculate line and column for reporting
        const beforeMatch = contentForMatching.substring(0, matchPosition);
        const lineNumber = beforeMatch.split('\n').length;
        
        // Get the lines from the original content that correspond to our match
        const originalLines = modifiedContent.split('\n');
        const normalizedLines = contentForMatching.split('\n');
        
        // Find the normalized line that contains our match start
        let normalizedLineIndex = 0;
        let charCount = 0;
        for (let i = 0; i < normalizedLines.length; i++) {
          if (charCount + normalizedLines[i].length + 1 > matchPosition) {
            normalizedLineIndex = i;
            break;
          }
          charCount += normalizedLines[i].length + 1; // +1 for newline
        }
        
        // Now we have the line number in the normalized text
        // Map this to the original text
        const matchingLineStart = normalizedLineIndex;
        
        // Find how many lines our match spans
        const matchLines = searchTextForMatching.split('\n').length;
        
        // Extract the corresponding section from the original content
        let originalSection = '';
        for (let i = matchingLineStart; i < matchingLineStart + matchLines && i < originalLines.length; i++) {
          originalSection += originalLines[i] + '\n';
        }
        originalSection = originalSection.slice(0, -1); // Remove trailing newline
        
        // Now replace this section with our new text, preserving indentation
        // Detect the indentation of the first line
        const indentMatch = originalLines[matchingLineStart].match(/^(\s*)/);
        const baseIndent = indentMatch ? indentMatch[1] : '';
        
        // Apply the indentation to each line of the new text
        const newTextLines = normalizedNew.split('\n');
        let indentedNewText = newTextLines.map((line, i) => {
          if (i === 0) return baseIndent + line.trimStart();
          return baseIndent + line;
        }).join('\n');
        
        // Track this edit for reporting
        appliedEdits.push({
          match: originalSection,
          replacement: indentedNewText,
          location: {
            line: matchingLineStart + 1, // 1-based line numbers
            column: originalLines[matchingLineStart].indexOf(originalLines[matchingLineStart].trim()) + 1
          }
        });
        
        // Apply the replacement
        modifiedContent = modifiedContent.replace(originalSection, indentedNewText);
        continue;
      }
    }
    
    // If we reach here, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;
    
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);
      
      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j];
        if (mode === 'exact') {
          return oldLine === contentLine;
        } else if (mode === 'structure') {
          return oldLine.trim() === contentLine.trim();
        } else {
          // Semantic mode - more flexible matching
          // This is a simple version - could be enhanced with AST parsing
          const trimmedOld = oldLine.trim();
          const trimmedContent = contentLine.trim();
          
          // Skip empty lines
          if (!trimmedOld && !trimmedContent) return true;
          
          // For code, match by structure not exact whitespace
          return trimmedOld === trimmedContent;
        }
      });
      
      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });
        
        // Track this edit for reporting
        appliedEdits.push({
          match: potentialMatch.join('\n'),
          replacement: newLines.join('\n'),
          location: {
            line: i + 1, // 1-based line numbers
            column: contentLines[i].indexOf(contentLines[i].trim()) + 1
          }
        });
        
        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }
    
    if (!matchFound) {
      throw new Error(`Could not find matching content for edit:\n${edit.oldText}`);
    }
  }
  
  // Format the code if requested and language is supported
  if (!dryRun && formatAfter && language) {
    try {
      console.log(`Formatting ${language} code...`);
      
      // Use our formatter implementation
      modifiedContent = await formatCode(modifiedContent, language, filePath);
    } catch (error) {
      console.error(`Formatting failed for ${language} file:`, error);
      // Continue without formatting if it fails
    }
  }
  
  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);
  
  // For dry run, include more detailed information about matches
  let response = '';
  if (dryRun) {
    response += `Edit Preview for ${filePath}\n\n`;
    
    if (appliedEdits.length > 0) {
      response += `Matched Edits:\n`;
      appliedEdits.forEach((edit, i) => {
        response += `\nEdit #${i+1} at line ${edit.location.line}, column ${edit.location.column}:\n`;
        if (includeContext) {
          response += `Original:\n\`\`\`\n${edit.match}\n\`\`\`\n`;
          response += `Replacement:\n\`\`\`\n${edit.replacement}\n\`\`\`\n`;
        }
      });
      
      response += `\n----- Diff Summary -----\n`;
    }
  }
  
  // Format diff with appropriate number of backticks
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  response += `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
  
  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, 'utf-8');
    response += `Applied ${edits.length} edit(s) to ${filePath}`;
    
    if (formatAfter && language) {
      response += ` and formatted with ${language} formatter`;
    }
  } else {
    response += `DRY RUN ONLY - No changes were written to disk.`;
    
    if (formatAfter && language) {
      response += ` (Would format with ${language} formatter after applying changes)`;
    }
  }
  
  return response;
}