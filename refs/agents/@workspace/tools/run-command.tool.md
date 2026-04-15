# run_command

Execute a shell command in the branch's isolated microVM container.

The microVM has:
- Ubuntu 24.04 with Node 22, Bun, git, jq, ripgrep
- Pre-installed SDKs: @datadog/datadog-api-client, @temporalio/client, snowflake-sdk, pg, @slack/web-api
- @slashfi/atlas-runtime SDK for calling back to Atlas
- Working directory: /workspace/scripts/

IMPORTANT:
- Commands run in a non-interactive shell
- Default timeout is 30 seconds
- Use is_background: true for long-running commands
- Use head/tail to limit large outputs
