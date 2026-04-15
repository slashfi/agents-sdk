# loop

Manage recurring loops that fire on a period.

Actions:
- create: Create a new loop (requires operation, periodMs, prompt OR callback, branchId)
- list: List loops (optional status filter)
- get: Get loop by id
- cancel: Cancel loop by id

Example create:
{"operation": "create", "periodMs": 300000, "prompt": "Check system health", "branchId": "new"}

Example with callback:
{"operation": "create", "periodMs": 3600000, "callback": {"action": "execute_tool", "path": "/agents/@worker", "tool": "cleanup"}, "branchId": "new"}
