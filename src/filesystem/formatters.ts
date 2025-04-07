import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

// --- Helper: Dart Formatter (using temp file) ---
export async function formatDartCode(content: string, filePath?: string): Promise<string> {
  let tempDir: string | undefined;
  // Determine a base name for the temporary file
  const baseName = filePath ? path.basename(filePath) : 'temp.dart';

  try {
    // 1. Create a temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-dart-format-'));
    const tempFilePath = path.join(tempDir, baseName);

    // 2. Write the original content to the temporary file
    await fs.writeFile(tempFilePath, content, 'utf-8');

    // 3. Run dart format on the temporary file (in place)
    const command = `dart format ${tempFilePath}`; // Always format the file now
    const { stdout: cmdStdout, stderr: cmdStderr} = await execAsync(command); // Capture output

    // Log any output for debugging, but don't rely on it for content
    if (cmdStdout) {
      console.debug(`Dart formatter stdout: ${cmdStdout.trim()}`);
    }
    if (cmdStderr) {
      // Dart often prints "Formatted X files" to stderr on success
      // Log it as debug unless it looks like a real error
      const stderrLower = cmdStderr.toLowerCase().trim();
      if (stderrLower && (stderrLower.includes('error') || !stderrLower.includes('formatted'))) {
        console.warn(`Dart formatter stderr: ${cmdStderr.trim()}`);
      } else if (stderrLower) {
        console.debug(`Dart formatter stderr: ${cmdStderr.trim()}`);
      }
    }

    // 4. Read the formatted content back from the temporary file
    const formattedContent = await fs.readFile(tempFilePath, 'utf-8');

    return formattedContent;

  } catch (error: any) {
    // Provide more context in the error
    let errorMessage = `Failed to format Dart code`;
    if (error.stderr) errorMessage += `\nStderr: ${error.stderr.trim()}`;
    if (error.stdout) errorMessage += `\nStdout: ${error.stdout.trim()}`;
    if (!error.stderr && !error.stdout) errorMessage += `: ${error.message}`;
    console.error(`Dart formatting failed: ${error.stack || error}`); // Log the full error stack
    throw new Error(errorMessage);
  } finally {
    // 5. Ensure cleanup happens even if errors occur
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`Failed to cleanup dart format temp directory ${tempDir}: ${cleanupError}`);
      }
    }
  }
}

// --- Helper: Go Formatter (using temp file) ---
export async function formatGoCode(content: string, filePath?: string): Promise<string> {
  let tempDir: string | undefined;
  const baseName = filePath ? path.basename(filePath) : 'temp.go';
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-go-format-'));
    const tempFilePath = path.join(tempDir, baseName);
    await fs.writeFile(tempFilePath, content, 'utf-8');

    // gofmt needs the -w flag to write back to the file
    const command = `gofmt -w ${tempFilePath}`;
    // gofmt usually outputs errors to stderr, stdout is typically empty on success
    const { stdout: cmdStdout, stderr: cmdStderr } = await execAsync(command);

    if (cmdStdout) {
      console.debug(`gofmt stdout: ${cmdStdout.trim()}`);
    }
    if (cmdStderr) {
      // Treat any stderr from gofmt as a potential issue/warning
      console.warn(`gofmt stderr: ${cmdStderr.trim()}`);
      // Decide if stderr always means failure for gofmt; often it doesn't if -w is used.
      // If formatting *fails*, gofmt might return non-zero exit code caught by execAsync.
    }

    const formattedContent = await fs.readFile(tempFilePath, 'utf-8');
    return formattedContent;

  } catch (error: any) {
    let errorMessage = `Failed to format Go code`;
    if (error.stderr) errorMessage += `\nStderr: ${error.stderr.trim()}`;
    if (error.stdout) errorMessage += `\nStdout: ${error.stdout.trim()}`;
    if (!error.stderr && !error.stdout) errorMessage += `: ${error.message}`;
    console.error(`Go formatting failed: ${error.stack || error}`);
    throw new Error(errorMessage);
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`Failed to cleanup go format temp directory ${tempDir}: ${cleanupError}`);
      }
    }
  }
}

// --- Helper: JS/TS/Etc. Formatter (Prettier, using temp file) ---
async function formatJsCode(
    content: string,
    language: string, // Determines parser
    filePath?: string // Used for file naming and potential config lookup
): Promise<string> {
  let tempDir: string | undefined;
  // Determine extension based on language or filePath
  let extension = '.tmp';
  if (filePath) {
    extension = path.extname(filePath);
  } else {
    switch (language) {
      case 'typescript': extension = '.ts'; break;
      case 'javascript': extension = '.js'; break;
      case 'tsx': extension = '.tsx'; break;
      case 'jsx': extension = '.jsx'; break;
      case 'json': extension = '.json'; break;
      case 'css': extension = '.css'; break;
      case 'html': extension = '.html'; break;
        // Add other relevant extensions
    }
  }

  const baseName = filePath ? path.basename(filePath) : `temp${extension}`;
  // Determine parser (can sometimes be inferred by prettier from extension)
  let parserOption = '';
  switch(language) {
    case 'typescript': parserOption = '--parser typescript'; break;
    case 'javascript': parserOption = '--parser babel'; break;
    case 'tsx': parserOption = '--parser typescript'; break; // or babel-tsx? TS is safer.
    case 'jsx': parserOption = '--parser babel'; break;
    case 'json': parserOption = '--parser json'; break;
    case 'css': parserOption = '--parser css'; break;
    case 'html': parserOption = '--parser html'; break;
      // Add others if needed, or let prettier infer
  }

  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-prettier-format-'));
    const tempFilePath = path.join(tempDir, baseName);
    await fs.writeFile(tempFilePath, content, 'utf-8');

    // Use --write to format in place. Pass parser explicitly for clarity.
    // Prettier might find config files relative to the original filePath if provided
    // but here we operate in temp dir, so config finding might be limited.
    // Using --stdin-filepath could help prettier find config, but doesn't fit the --write model.
    const command = `prettier --write ${tempFilePath} ${parserOption}`;
    const { stdout: cmdStdout, stderr: cmdStderr } = await execAsync(command);

    // Prettier often outputs timing/filename to stderr on success
    if (cmdStdout) console.debug(`Prettier stdout: ${cmdStdout.trim()}`);
    // Only warn if stderr contains 'error' or seems problematic
    const stderrLower = cmdStderr.toLowerCase().trim();
    if (stderrLower && stderrLower.includes('error')) {
      console.warn(`Prettier stderr: ${cmdStderr.trim()}`);
    } else if (stderrLower) {
      console.debug(`Prettier stderr: ${cmdStderr.trim()}`); // Log timing info etc. as debug
    }

    const formattedContent = await fs.readFile(tempFilePath, 'utf-8');
    return formattedContent;

  } catch (error: any) {
    let errorMessage = `Failed to format ${language} code with Prettier`;
    // Prettier error output often goes to stderr when exec fails
    if (error.stderr) errorMessage += `\nStderr: ${error.stderr.trim()}`;
    if (error.stdout) errorMessage += `\nStdout: ${error.stdout.trim()}`; // Less common for errors
    if (!error.stderr && !error.stdout) errorMessage += `: ${error.message}`;
    console.error(`Prettier formatting failed for ${language}: ${error.stack || error}`);
    throw new Error(errorMessage);
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`Failed to cleanup prettier format temp directory ${tempDir}: ${cleanupError}`);
      }
    }
  }
}

// --- Main Formatting Dispatcher ---
export async function formatCode(
    content: string,
    language: string,
    filePath?: string // Pass this down
): Promise<string> {

  // Handle mock formatters during tests
  if (process.env.NODE_ENV === 'test' || process.env.VITEST_POOL_ID) {
    console.debug(`Using mock formatter for ${language}`);
    switch (language) {
      case 'dart': return mockFormatDart(content);
      case 'go': return mockFormatGo(content);
      case 'javascript': return mockFormatJavaScript(content);
      case 'typescript': return mockFormatTypeScript(content);
      case 'python': return mockFormatPython(content);
        // Add mocks for other languages if formatters are added
      default:
        console.warn(`Mock formatter not implemented for ${language}, returning original content.`);
        return content;
    }
  }

  // Dispatch to the appropriate real formatter
  console.debug(`Formatting code for language: ${language}, filePath: ${filePath ?? 'N/A'}`);
  switch (language) {
    case 'dart':
      return formatDartCode(content, filePath);
    case 'go':
      return formatGoCode(content, filePath);
    case 'javascript':
    case 'typescript':
    case 'jsx':
    case 'tsx':
    case 'json':
    case 'css':
    case 'html': // Add other prettier-supported languages if desired
      return formatJsCode(content, language, filePath); // Pass language for parser selection
      // Add cases for other formatters like black (Python) if installed/needed
      // case 'python':
      //   return formatPythonCode(content, filePath);
    default:
      console.warn(`Unsupported language for formatting: ${language}. Returning original content.`);
      return content; // Return original content if formatter not found
  }
}


// --- Mock Formatters (for testing) ---

// Simple pass-through mocks - adjust if specific test behaviour is needed
function mockFormatDart(content: string): string {
  console.debug("Called mockFormatDart");
  return content + "\n// MOCK FORMATTED DART"; // Add suffix to confirm mock was called
}
function mockFormatGo(content: string): string {
  console.debug("Called mockFormatGo");
  return content + "\n// MOCK FORMATTED GO";
}
function mockFormatJavaScript(content: string): string {
  console.debug("Called mockFormatJavaScript");
  return content + "\n// MOCK FORMATTED JAVASCRIPT";
}
function mockFormatTypeScript(content: string): string {
  console.debug("Called mockFormatTypeScript");
  return content + "\n// MOCK FORMATTED TYPESCRIPT";
}
function mockFormatPython(content: string): string {
  console.debug("Called mockFormatPython");
  return content + "\n# MOCK FORMATTED PYTHON";
}

// This function itself doesn't do much other than signal that mocks *should* be used
// The actual mocking happens within formatCode based on NODE_ENV/VITEST_POOL_ID check.
// You could enhance this to dynamically replace the exported functions if needed,
// but the current check within formatCode is simpler.
export function mockFormatters() {
  console.warn("mockFormatters() called. Mocking is active if NODE_ENV is 'test' or VITEST_POOL_ID is set.");
  // In a more complex setup (e.g., using Jest/Sinon), you might replace implementations here:
  // formatDartCode = mockFormatDart; // etc.
  // But the current env check within formatCode handles it for Vitest/basic testing.
}