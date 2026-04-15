# call_workspace_tool

Call any tool on the branch's microVM MCP server.

Available tools:
- run_terminal_cmd: Execute shell commands
- read_file: Read file contents (with optional offset/limit)
- write: Create/overwrite a file
- search_replace: Find and replace text in a file
- delete_file: Delete a file
- list_dir: List directory contents
- grep: Search file contents (uses ripgrep)
