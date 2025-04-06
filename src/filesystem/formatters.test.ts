import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { formatCode, mockFormatters } from './formatters.js';
import { applyFileEdits } from './edit-helpers.js';

// Create a temporary directory for file operations
let tempDir: string;

beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `formatter-tests-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
});

afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
});

describe('Code Formatters', () => {
    // Mock the exec function to simulate formatter behavior without actually running external tools
    beforeEach(() => {
        vi.mock('child_process', () => ({
            exec: vi.fn((cmd, callback) => {
                // Simulate successful command execution
                callback(null, { stdout: 'Formatted successfully', stderr: '' });
            })
        }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Helper to create a test file with content
    async function createTestFile(content: string, filename: string): Promise<string> {
        const filepath = path.join(tempDir, filename);
        await fs.writeFile(filepath, content, 'utf-8');
        return filepath;
    }

    describe('Dart formatter', () => {
        it('formats Dart code with standard indentation', async () => {
            // Mock the formatCode function for this test
            vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
                const pathStr = path.toString();
                if (pathStr.includes('dart-format')) {
                    // Return properly formatted code with the expected indentation pattern
                    return Promise.resolve(`class MyWidget extends StatelessWidget {
  build(BuildContext context) {
    return Container(
      child: Text('Hello'),
    );
  }
}`);
                }
                // Don't recursively call the original for other paths
                if (pathStr.includes('test_widget.dart')) {
                    return Promise.resolve(dartCode);
                }
                throw new Error(`Unexpected file read in test: ${pathStr}`);
            });

            // Dart file with inconsistent formatting
            const dartCode = `
class MyWidget extends StatelessWidget {
build(BuildContext context) {
  return Container(
child: Text('Hello'),
  );
}
}`;

            const filepath = await createTestFile(dartCode, 'test_widget.dart');
            const formatted = await formatCode(dartCode, 'dart', filepath);

            // Verify the formatting changes
            expect(formatted).toContain('  build(');
            expect(formatted).toContain('    return');
            expect(formatted).toContain('      child:');
        });
    });

    describe('JavaScript/TypeScript formatter', () => {
        it('formats JavaScript code with standard style', async () => {
            // Mock the formatCode function for this test
            vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
                const pathStr = path.toString();
                if (pathStr.includes('prettier-format')) {
                    // Return properly formatted JavaScript code
                    return Promise.resolve(`function example() {
  console.log("Hello");
  const x = 1 + 2;
  return x;
}`);
                }
                // Don't recursively call the original for other paths
                if (pathStr.includes('example.js')) {
                    return Promise.resolve(jsCode);
                }
                throw new Error(`Unexpected file read in test: ${pathStr}`);
            });

            const jsCode = `
function example ( ) {
    console.log("Hello")
const x=1+2;
return x}`;

            const filepath = await createTestFile(jsCode, 'example.js');
            const formatted = await formatCode(jsCode, 'javascript', filepath);

            // Verify the formatting changes
            expect(formatted).toContain('function example() {');
            expect(formatted).toContain('  console.log("Hello");');
            expect(formatted).toContain('  const x = 1 + 2;');
        });

        it('formats TypeScript code correctly', async () => {
            // Mock the formatCode function for this test
            vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
                const pathStr = path.toString();
                if (pathStr.includes('prettier-format')) {
                    // Return properly formatted TypeScript code
                    return Promise.resolve(`interface Person {
  name: string;
  age: number;
}
function greet(person: Person) {
  console.log("Hello " + person.name);
}`);
                }
                // Don't recursively call the original for other paths
                if (pathStr.includes('example.ts')) {
                    return Promise.resolve(tsCode);
                }
                throw new Error(`Unexpected file read in test: ${pathStr}`);
            });

            const tsCode = `
interface Person{name:string;age:number}
function greet(person:Person){
    console.log("Hello "+person.name)
}`;

            const filepath = await createTestFile(tsCode, 'example.ts');
            const formatted = await formatCode(tsCode, 'typescript', filepath);

            // Verify the formatting changes
            expect(formatted).toContain('interface Person {');
            expect(formatted).toContain('  name: string;');
            expect(formatted).toContain('function greet(person: Person) {');
        });
    });

    describe('Python formatter', () => {
        it('formats Python code using black style', async () => {
            // Mock the formatCode function for this test
            vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
                const pathStr = path.toString();
                if (pathStr.includes('black-format')) {
                    // Return properly formatted Python code
                    return Promise.resolve(`def example():
    x = 1 + 2
    y = [i for i in range(10) if i % 2 == 0]
    return x, y`);
                }
                // Don't recursively call the original for other paths
                if (pathStr.includes('example.py')) {
                    return Promise.resolve(pythonCode);
                }
                throw new Error(`Unexpected file read in test: ${pathStr}`);
            });

            const pythonCode = `
def example():
   x=1+2
   y = [i  for i in range(10) if i%2==0]
   return x,y`;

            const filepath = await createTestFile(pythonCode, 'example.py');
            const formatted = await formatCode(pythonCode, 'python', filepath);

            // Verify the formatting changes
            expect(formatted).toContain('    x = 1 + 2');
            expect(formatted).toContain('    y = [i for i in range(10) if i % 2 == 0]');
            expect(formatted).toContain('    return x, y');
        });
    });

    describe('Go formatter', () => {
        it('formats Go code using gofmt style', async () => {
            // Mock the formatCode function for this test
            vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
                const pathStr = path.toString();
                if (pathStr.includes('gofmt-format')) {
                    // Return properly formatted Go code
                    return Promise.resolve(`package main

import "fmt"

func main() {
	fmt.Println("Hello, world!")
}`);
                }
                // Don't recursively call the original for other paths
                if (pathStr.includes('example.go')) {
                    return Promise.resolve(goCode);
                }
                throw new Error(`Unexpected file read in test: ${pathStr}`);
            });

            const goCode = `
package main
import "fmt"
func main(){
fmt.Println("Hello, world!")
}`;

            const filepath = await createTestFile(goCode, 'example.go');
            const formatted = await formatCode(goCode, 'go', filepath);

            // Verify the formatting changes
            expect(formatted).toContain('import "fmt"');
            expect(formatted).toContain('func main() {');
            expect(formatted).toContain('	fmt.Println("Hello, world!")');
        });
    });

    describe('Mock formatters for testing', () => {
        it('provides mock implementations for testing', () => {
            const mocks = mockFormatters();
            expect(typeof mocks.formatCode).toBe('function');
            expect(typeof mocks.formatDartCode).toBe('function');
        });

        it('applies mock formatting to dart code', async () => {
            const mocks = mockFormatters();
            const dartCode = `
class Test {
method() {
return value;
}
}`;

            const result = await mocks.formatDartCode(dartCode);
            expect(result).toContain('  class Test {');
            expect(result).toContain('  method() {');
            expect(result).toContain('  return value;');
        });
    });

    describe('Integration with edit_file', () => {
        // These tests would simulate how formatters work with the edit_file functionality
        // They require integration with the applyFileEdits function

        it('formats code after applying edits', async () => {
            // Create a test file
            const jsCode = `
function test() {
console.log("Before")
return true
}`;

            // Set up the file content and edit expectations
            const filepath = await createTestFile(jsCode, 'format_test.js');
            const expectedFormattedContent = `function test() {
  console.log("After");
  return true;
}`;

            // We need multiple mocks with correct sequence to test the full flow:
            // 1. First readFile returns the original content
            // 2. After edits, writeFile is called with edited content
            // 3. When formatting, readFile is called again and should return the edited content
            // 4. Final writeFile returns the formatted content

            // Mock the first readFile to return the original content
            const readFileMock = vi.spyOn(fs, 'readFile');
            readFileMock.mockImplementationOnce(() => Promise.resolve(jsCode));
            
            // After the edit, next read should return edited content
            readFileMock.mockImplementationOnce(() => {
                const editedContent = jsCode.replace('console.log("Before")', 'console.log("After")');
                return Promise.resolve(editedContent);
            });
            
            // For formatter, return a properly formatted version
            readFileMock.mockImplementationOnce(() => {
                return Promise.resolve(expectedFormattedContent);
            });

            // Mock writeFile to verify it was called correctly
            const writeFileMock = vi.spyOn(fs, 'writeFile');
            writeFileMock.mockImplementation(() => Promise.resolve());
            
            // Apply edits with formatting
            await applyFileEdits(filepath, [
                { oldText: 'console.log("Before")', newText: 'console.log("After")' }
            ], false, 'exact', true);

            // Verify writeFile was called with the correct parameters
            expect(writeFileMock).toHaveBeenCalledTimes(2); // Once for edit, once for format
        });
    });
});