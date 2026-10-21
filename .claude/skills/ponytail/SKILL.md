---
name: ponytail
description: Append content to files safely and efficiently
---

# Ponytail Skill

Use this project-local skill for append-only changes to large files. Read the relevant surrounding code and callers first; appending is appropriate only when the file format and module structure allow it.

## Usage

When you need to add content to the end of a file, use this skill to:

1. Append new code to existing files
2. Add new entries to configuration files
3. Add new test cases to test files
4. Add exports at the end of an index file when its module structure permits it

## Instructions

1. For small files (<100 lines), you can Read and Edit normally
2. For larger files, use this approach:
   - Read only the last ~50 lines with `limit` and `offset` parameters
   - Use Edit to append content after the last line
   - This avoids loading the entire file into context

3. Always verify the append was successful
4. Maintain consistent formatting and style
5. For imports, structured configuration, or edits inside an existing function, inspect the relevant section and edit in place instead of appending blindly

## Examples

- "Add a new test case to the test file"
- "Append a new route to the router configuration"
- "Add a new export to the index file"
- "Add a new function to the utilities file"

## Implementation Pattern

```javascript
// For a file with 1000 lines, to append content:
// 1. Read last 50 lines: Read(file, offset: 950, limit: 50)
// 2. Edit with old_string = last few lines, new_string = last few lines + new content
```
