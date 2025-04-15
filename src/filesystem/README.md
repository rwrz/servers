# Filesystem MCP Server

Node.js server implementing Model Context Protocol (MCP) for filesystem operations.

## Features

- Read/write files
- Create/list/delete directories
- Move files/directories
- Search files
- Get file metadata
- Advanced file editing with multiple matching modes

**Note**: The server will only allow operations within directories specified via `args`.

## API

### Resources

- `file://system`: File system operations interface

### Tools

- **read_file**
  - Read complete contents of a file
  - Input: `path` (string)
  - Reads complete file contents with UTF-8 encoding

- **read_multiple_files**
  - Read multiple files simultaneously
  - Input: `paths` (string[])
  - Failed reads won't stop the entire operation

- **write_file**
  - Create new file or overwrite existing (exercise caution with this)
  - Inputs:
    - `path` (string): File location
    - `content` (string): File content

- **edit_file**
  - Make selective edits using different modes: simple text replacement, structure-aware replacement, applying a unified diff patch, or smart search with normalization and disambiguation.
  - Features:
    - Multiple modes for different use cases:
      - `exact`: Strict text matching (default). Requires `edits` input.
      - `structure`: Ignores whitespace & comments for code editing. Requires `edits` input.
      - `semantic`: (Future) Intelligent structure-aware code matching. Requires `edits` input.
      - `patch`: Applies a standard unified diff patch. Requires `patch` input.
      - `smart`: Advanced matching with normalization options and disambiguation for ambiguous matches. Requires `edits` input.
    - For `exact`/`structure`/`semantic` modes:
      - Line-based and multi-line content matching.
      - Whitespace normalization with indentation preservation.
      - Multiple simultaneous edits with correct positioning.
      - Indentation style detection and preservation.
      - Git-style diff output with optional context (`includeContext`).
    - For `patch` mode:
      - Applies standard unified diff patches precisely using context.
      - Handles context matching automatically via the patch format.
      - Git-style diff output for preview (`dryRun`).
    - For `smart` mode:
      - Advanced normalization options for flexible matching.
      - Fuzzy matching with configurable similarity threshold.
      - Interactive disambiguation for ambiguous matches.
      - Character-level offset mapping between normalized and original content.
      - Comprehensive context information for choosing between multiple matches.
    - Preview changes with `dryRun` mode (applies to all modes).
    - Auto-formatting option (`formatAfter`) for supported languages (applies to all modes).
  - Inputs:
    - `path` (string): File to edit.
    - `mode` (string): Editing mode - "exact", "structure", "semantic", "patch", or "smart" (default: "exact").
    - `edits` (array): *Required* if `mode` is "exact", "structure", "semantic", or "smart". List of edit operations:
      - `oldText` (string): Text to search for.
      - `newText` (string): Text to replace with.
    - `patch` (string): *Required* if `mode` is "patch". A unified diff patch string (e.g., from `git diff`).
    - `normalizationOptions` (object): *Optional* for `smart` mode. Controls how text is normalized before matching.
      - `ignoreComments` (boolean, default: true): Remove code comments.
      - `ignoreLeadingWhitespace` (boolean, default: true): Trim whitespace from start of lines.
      - `ignoreTrailingWhitespace` (boolean, default: true): Trim whitespace from end of lines.
      - `ignoreInternalWhitespace` (string, default: "collapse"): How to handle whitespace within lines ("collapse", "remove", or "keep").
      - `ignoreBlankLines` (boolean, default: true): Ignore blank lines.
      - `caseSensitive` (boolean, default: true): Whether to consider case.
    - `similarityThreshold` (number): *Optional* for `smart` mode. Minimum similarity (0.0-1.0) required for a match (default: 1.0).
    - `disambiguationIndex` (integer): *Optional* for `smart` mode. 1-based index to select a match when multiple ambiguous matches were found in previous call.
    - `dryRun` (boolean): Preview changes without applying (default: false).
    - `formatAfter` (boolean): Auto-format code after edits/patch (default: false).
    - `includeContext` (boolean): Include context lines in diff output for `dryRun` (default: true).
  - Returns detailed diff and match information for dry runs, or confirmation/diff upon success.
  - **Best Practice**: Always use `dryRun=true` first to preview changes before applying them, regardless of the mode. For `patch` mode, ensure the patch is generated against the current file state.

- **create_directory**
  - Create new directory or ensure it exists
  - Input: `path` (string)
  - Creates parent directories if needed
  - Succeeds silently if directory exists

- **list_directory**
  - List directory contents with [FILE] or [DIR] prefixes
  - Input: `path` (string)

- **directory_tree**
  - Get a recursive tree view of files and directories
  - Input: `path` (string)
  - Returns a JSON structure with file/directory information

- **move_file**
  - Move or rename files and directories
  - Inputs:
    - `source` (string)
    - `destination` (string)
  - Fails if destination exists

- **search_files**
  - Recursively search for files/directories
  - Inputs:
    - `path` (string): Starting directory
    - `pattern` (string): Search pattern
    - `excludePatterns` (string[]): Exclude any patterns. Glob formats are supported.
  - Case-insensitive matching
  - Returns full paths to matches

- **get_file_info**
  - Get detailed file/directory metadata
  - Input: `path` (string)
  - Returns:
    - Size
    - Creation time
    - Modified time
    - Access time
    - Type (file/directory)
    - Permissions

- **list_allowed_directories**
  - List all directories the server is allowed to access
  - No input required
  - Returns:
    - Directories that this server can read/write from

## Advanced Editing Examples

### Smart Search/Replace with Ambiguity Detection
```json
{
  "path": "src/components/UserProfile.tsx",
  "mode": "smart",
  "edits": [
    {
      "oldText": "const userStatus = user.isActive ? 'Active' : 'Inactive';",
      "newText": "const userStatus = user.isActive ? 'Active' : (user.isPending ? 'Pending' : 'Inactive');"
    }
  ],
  "normalizationOptions": {
    "ignoreComments": true,
    "ignoreWhitespace": true,
    "caseSensitive": true
  },
  "similarityThreshold": 0.9,
  "dryRun": true
}
```

This might return an ambiguous response if multiple matches are found:

```json
{
  "status": "AMBIGUOUS",
  "message": "Multiple potential matches found for edit 1. Please specify the index (1-based) in 'disambiguationIndex' on your next request.",
  "matches": [
    {
      "index": 1,
      "originalLocation": { "start": 245, "end": 302 },
      "context": "function UserStatus() {\n  const userStatus = user.isActive ? 'Active' : 'Inactive';\n  return <span"
    },
    {
      "index": 2,
      "originalLocation": { "start": 1050, "end": 1107 },
      "context": "  renderStatus() {\n    const userStatus = user.isActive ? 'Active' : 'Inactive';\n    return <Badge"
    }
  ]
}
```

Disambiguate by providing the index in the follow-up request:

```json
{
  "path": "src/components/UserProfile.tsx",
  "mode": "smart",
  "edits": [
    {
      "oldText": "const userStatus = user.isActive ? 'Active' : 'Inactive';",
      "newText": "const userStatus = user.isActive ? 'Active' : (user.isPending ? 'Pending' : 'Inactive');"
    }
  ],
  "normalizationOptions": {
    "ignoreComments": true,
    "ignoreWhitespace": true,
    "caseSensitive": true
  },
  "similarityThreshold": 0.9,
  "disambiguationIndex": 1,
  "dryRun": false
}
```

### Standard Edit (`exact` mode - default)
```json
{
  "path": "src/app.js",
  "edits": [
    {
      "oldText": "function hello() {\n  console.log('hello');\n}",
      "newText": "function hello() {\n  console.log('hello world');\n}"
    }
  ],
  "dryRun": true
}
```

### Patch Edit (`patch` mode)
```json
{
  "toolName": "edit_file",
  "input": {
    "path": "lib/infrastructure/di/service_locator.dart",
    "mode": "patch",
    "patch": "--- a/lib/infrastructure/di/service_locator.dart\n+++ b/lib/infrastructure/di/service_locator.dart\n@@ -1,5 +1,6 @@\n import 'package:get_it/get_it.dart';\n import 'package:yodfinance/domain/repositories/institution_repository.dart';\n+import 'package:yodfinance/domain/repositories/installment_group_repository.dart'; // NEW\n import 'package:yodfinance/domain/repositories/category_repository.dart';\n import '../../domain/repositories/account_repository.dart';\n import '../../domain/repositories/statement_import_repository.dart';\n@@ -54,6 +55,7 @@\n       transactionRepository: getIt(),\n       statementImportRepository: getIt(),\n       accountRepository: getIt(),\n+      installmentGroupRepository: getIt(), // NEW\n     ),\n   );",
    "dryRun": true,
    "formatAfter": true
  }
}
```

### Flutter/Dart Edit with Structure Mode
```json
{
  "path": "lib/widgets/transaction_list_item.dart",
  "edits": [
    {
      "oldText": "trailing: Text(\n  currencyFormat.format(transactionWithCategory.transaction.amount),\n  style: theme.textTheme.bodyLarge?.copyWith(\n    fontFamily: 'RobotoMono',\n    fontWeight: FontWeight.bold,\n    color: amountColor,\n  ),\n),",
      "newText": "trailing: Text(\n  currencyFormat.format(transactionWithCategory.transaction.amount),\n  style: theme.textTheme.bodyLarge?.copyWith(\n    fontFamily: 'RobotoMono',\n    fontWeight: FontWeight.bold,\n    color: amountColor,\n    fontSize: 16,\n  ),\n),"
    }
  ],
  "mode": "structure",
  "formatAfter": true,
  "dryRun": true
}
```

## Usage with Claude Desktop
Add this to your `claude_desktop_config.json`:

Note: you can provide sandboxed directories to the server by mounting them to `/projects`. Adding the `ro` flag will make the directory readonly by the server.

### Docker
Note: all directories must be mounted to `/projects` by default.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--mount", "type=bind,src=/Users/username/Desktop,dst=/projects/Desktop",
        "--mount", "type=bind,src=/path/to/other/allowed/dir,dst=/projects/other/allowed/dir,ro",
        "--mount", "type=bind,src=/path/to/file.txt,dst=/projects/path/to/file.txt",
        "mcp/filesystem",
        "/projects"
      ]
    }
  }
}
```

### NPX

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/Desktop",
        "/path/to/other/allowed/dir"
      ]
    }
  }
}
```

## Build

Docker build:

```bash
docker build -t mcp/filesystem -f src/filesystem/Dockerfile .
```

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
