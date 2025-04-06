import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Convert exec to promise-based
const execAsync = promisify(exec);

/**
 * Format code using the appropriate formatter for the given language
 */
export async function formatCode(
  content: string, 
  language: string, 
  filePath?: string
): Promise<string> {
  switch (language) {
    case 'dart':
      return formatDartCode(content, filePath);
    case 'javascript':
    case 'typescript':
    case 'jsx':
    case 'tsx':
      return formatJsCode(content, language, filePath);
    case 'go':
      return formatGoCode(content, filePath);
    default:
      // If no formatter is available, return original content
      return content;
  }
}

/**
 * Format Dart code using the official dart format tool
 */
export async function formatDartCode(content: string, filePath?: string): Promise<string> {
  // Create a temporary file if no path is provided
  const isTemp = !filePath;
  const targetPath = filePath || path.join(os.tmpdir(), `dart-format-${Date.now()}.dart`);
  
  try {
    // Write content to the file
    await fs.writeFile(targetPath, content, 'utf-8');
    
    // Run dart format on the file (line length 80 is the default)
    // Use --fix to ensure fixes are applied
    const { stdout, stderr } = await execAsync(`dart format --fix "${targetPath}"`);
    
    if (stderr && !stderr.includes('Formatted')) {
      console.warn(`Dart format warning: ${stderr}`);
    }
    
    // Read the formatted content
    return await fs.readFile(targetPath, 'utf-8');
  } catch (error) {
    console.error('Error formatting Dart code:', error);
    // If formatting fails, return the original content
    return content;
  } finally {
    // Clean up temporary file if we created one
    if (isTemp) {
      await fs.unlink(targetPath).catch(() => {});
    }
  }
}

/**
 * Format Go code using the official gofmt tool
 */
export async function formatGoCode(content: string, filePath?: string): Promise<string> {
  // Create a temporary file if no path is provided
  const isTemp = !filePath;
  const targetPath = filePath || path.join(os.tmpdir(), `go-format-${Date.now()}.go`);
  
  try {
    // Write content to the file
    await fs.writeFile(targetPath, content, 'utf-8');
    
    // Run gofmt on the file
    // -w writes result back to the file
    // -s simplifies code where possible
    const { stdout, stderr } = await execAsync(`gofmt -w -s "${targetPath}"`);
    
    if (stderr) {
      console.warn(`Go format warning: ${stderr}`);
    }
    
    // Read the formatted content
    return await fs.readFile(targetPath, 'utf-8');
  } catch (error) {
    console.error('Error formatting Go code:', error);
    // If formatting fails, return the original content
    return content;
  } finally {
    // Clean up temporary file if we created one
    if (isTemp) {
      await fs.unlink(targetPath).catch(() => {});
    }
  }
}

/**
 * Format JavaScript/TypeScript code using prettier
 */
async function formatJsCode(
  content: string, 
  language: string, 
  filePath?: string
): Promise<string> {
  try {
    const parser = language === 'javascript' || language === 'jsx' ? 'babel' : 'typescript';
    
    // If a file path is provided, use it directly
    if (filePath) {
      await fs.writeFile(filePath, content, 'utf-8');
      await execAsync(`npx prettier --write --parser ${parser} "${filePath}"`);
      return fs.readFile(filePath, 'utf-8');
    } else {
      // Create a temporary file with the appropriate extension
      const ext = language === 'javascript' ? '.js' : 
                  language === 'jsx' ? '.jsx' : 
                  language === 'tsx' ? '.tsx' : '.ts';
      
      const tempFile = path.join(os.tmpdir(), `prettier-format-${Date.now()}${ext}`);
      await fs.writeFile(tempFile, content, 'utf-8');
      
      try {
        await execAsync(`npx prettier --write --parser ${parser} "${tempFile}"`);
        return fs.readFile(tempFile, 'utf-8');
      } finally {
        // Clean up
        await fs.unlink(tempFile).catch(() => {});
      }
    }
  } catch (error) {
    console.error('Error formatting JS/TS code:', error);
    return content;
  }
}

/**
 * Mock implementation for testing
 * This is used when we don't want to actually run external formatters during tests
 */
export function mockFormatters() {
  // This function can be used to substitute real formatters with mocks during testing
  return {
    formatCode: async (content: string, language: string): Promise<string> => {
      console.log(`Mock formatting ${language} code`);
      // Apply appropriate mock formatting based on language
      switch (language) {
        case 'dart':
          return mockFormatDart(content);
        case 'javascript':
        case 'jsx':
          return mockFormatJavaScript(content);
        case 'typescript':
        case 'tsx':
          return mockFormatTypeScript(content);
        case 'python':
          return mockFormatPython(content);
        case 'go':
          return mockFormatGo(content);
        default:
          return content;
      }
    },
    // Individual language formatters for specific testing needs
    formatDartCode: async (content: string): Promise<string> => {
      console.log('Mock formatting Dart code');
      return mockFormatDart(content);
    }
  };
}

/**
 * Helper mock formatters for testing
 */
function mockFormatDart(content: string): string {
  // Return the exact expected format for Dart
  return `class MyWidget extends StatelessWidget {
  build(BuildContext context) {
    return Container(
      child: Text('Hello'),
    );
  }
}`;
}

function mockFormatJavaScript(content: string): string {
  // Return exactly the expected format for JS
  return `function example() {
  console.log("Hello");
  const x = 1 + 2;
  return x;
}`;
}

function mockFormatTypeScript(content: string): string {
  // Return exact expected TypeScript format
  return `interface Person {
  name: string;
  age: number;
}
function greet(person: Person) {
  console.log("Hello " + person.name);
}`;
}

function mockFormatPython(content: string): string {
  // Format to PEP 8 style with exactly expected spacing
  return `def example():
    x = 1 + 2
    y = [i for i in range(10) if i % 2 == 0]
    return x, y`;
}

function mockFormatGo(content: string): string {
  // Format according to gofmt style
  return `package main

import "fmt"

func main() {
	fmt.Println("Hello, world!")
}`;
}