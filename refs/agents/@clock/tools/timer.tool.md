# timer

Manage one-shot timers that fire at a scheduled time.

Operations:
- create: Create a new timer (requires operation, delayMs OR fireAt, prompt OR callback, branchId)
- list: List timers (optional status filter)
- get: Get timer by id
- cancel: Cancel timer by id

Example create:
{"operation": "create", "delayMs": 60000, "prompt": "Time to check in", "branchId": "self"}

Example with callback:
{"operation": "create", "fireAt": "2026-03-12T17:00:00Z", "callback": {"action": "invoke", "path": "/agents/atlas-slack", "prompt": "Send reminder"}, "branchId": "new"}
