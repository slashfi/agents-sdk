const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;background:#f9f8f7;color:#1a1917;-webkit-font-smoothing:antialiased}a{color:#c4982a;text-decoration:none}.page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border:1px solid #e4ddd6;border-radius:10px;padding:32px;max-width:440px;width:100%;box-shadow:0 4px 6px -2px rgba(21,20,15,.1)}.logo{display:flex;align-items:center;gap:10px;margin-bottom:12px}.logo h1{font-size:20px;font-weight:600;letter-spacing:-.02em}.subtitle{color:#6b6560;font-size:14px;line-height:1.5;margin-bottom:28px}input[type=text],input[type=email]{width:100%;padding:10px 14px;background:#fff;border:1px solid #e4ddd6;border-radius:8px;color:#1a1917;font-size:14px;outline:none;margin-bottom:12px}input:focus{border-color:#c4982a;box-shadow:0 0 0 3px rgba(196,152,42,.08)}input::placeholder{color:#9c958e}label{display:block;font-size:13px;font-weight:500;color:#6b6560;margin-bottom:6px}.hint{font-size:12px;color:#9c958e;margin-bottom:16px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;width:100%;transition:all .15s}.btn-primary{background:#1a1917;color:#fff}.btn-primary:hover{background:#2d2c28}.btn-google{background:#fff;color:#1a1917;border:1px solid #e4ddd6;margin-bottom:12px}.btn-google:hover{background:#f4f3f1}.btn-ghost{background:transparent;color:#6b6560;border:1px solid #e4ddd6;padding:6px 16px;width:auto;font-size:13px}.btn-ghost:hover{color:#1a1917;background:#f4f3f1}.btn-copy{background:#f4f3f1;color:#6b6560;border:1px solid #e4ddd6;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap}.btn-copy:hover{background:rgba(196,152,42,.08);color:#c4982a}.footer{text-align:center;font-size:12px;color:#9c958e;margin-top:20px}.dashboard{max-width:720px;width:100%}.dash-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}.section{background:#fff;border:1px solid #e4ddd6;border-radius:10px;padding:24px;margin-bottom:16px;box-shadow:0 1px 1px rgba(21,20,15,.05)}.section h2{font-size:15px;font-weight:600;margin-bottom:4px;letter-spacing:-.01em}.section .desc{font-size:13px;color:#6b6560;margin-bottom:16px}.cb{display:flex;align-items:center;gap:8px;background:#f4f3f1;border:1px solid #e4ddd6;border-radius:8px;padding:10px 14px}.cb code{flex:1;font-size:13px;font-family:'SF Mono',Menlo,monospace;word-break:break-all}.sg{display:grid;gap:12px}.sc{background:#f4f3f1;border:1px solid #e4ddd6;border-radius:8px;padding:16px}.sc h3{font-size:14px;font-weight:600;margin-bottom:8px}.cbl{display:flex;align-items:flex-start;gap:8px;background:#fff;border:1px solid #e4ddd6;border-radius:6px;padding:10px 12px}.cbl code{flex:1;font-size:12px;font-family:'SF Mono',Menlo,monospace;white-space:pre-wrap;word-break:break-all;color:#6b6560}.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none}`;

function h(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function renderLoginPage(_baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Registry</title>
<style>${css}</style></head>
<body>
<div class="page">
  <div class="card">
    <div class="logo"><span style="font-size:24px">\u2B21</span><h1>Agent Registry</h1></div>
    <p class="subtitle">Connect your AI agents to any API. Set up integrations, manage credentials securely, and get an MCP endpoint for Claude, Cursor, and more.</p>
    <div id="err" class="err"></div>
    <form id="f" method="POST" action="/login">
      <div id="step1">
        <input type="email" name="email" placeholder="Email address" required autocomplete="email">
        <button type="button" class="btn btn-google" onclick="document.getElementById('step1').style.display='none';document.getElementById('step2').style.display='block'">Continue with Google</button>
      </div>
      <div id="step2" style="display:none">
        <label>Choose a registry name</label>
        <input type="text" name="tenant" placeholder="my-company" required pattern="[a-z0-9-]+" autocomplete="off">
        <p class="hint">This will be your workspace identifier.</p>
        <button type="submit" class="btn btn-primary">Create Registry</button>
      </div>
    </form>
    <p class="footer">By continuing, you agree to our terms of service.</p>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const r = await fetch('/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email: fd.get('email'), tenant: fd.get('tenant')}) });
    const d = await r.json();
    if (d.token) { localStorage.setItem('registry_token', d.token); window.location.href = '/dashboard?token=' + d.token; }
    else { const el = document.getElementById('err'); el.textContent = d.error || 'Failed to create'; el.style.display = 'block'; }
  } catch(err) { document.getElementById('err').textContent = err.message; document.getElementById('err').style.display = 'block'; }
  finally { btn.disabled = false; btn.textContent = 'Create Registry'; }
});
</script></body></html>`;
}

export function renderDashboardPage(baseUrl: string, token: string): string {
  const mcpUrl = `${baseUrl}/mcp?token=${h(token)}`;
  const claudeCmd = `claude mcp add agent-registry ${mcpUrl}`;
  const desktopJson = JSON.stringify({ mcpServers: { "agent-registry": { url: mcpUrl } } }, null, 2);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — Agent Registry</title>
<style>${css}</style></head>
<body>
<div class="page">
  <div class="dashboard">
    <header class="dash-header">
      <div class="logo"><span style="font-size:24px">\u2B21</span><h1>Agent Registry</h1></div>
      <a href="/" class="btn btn-ghost" onclick="localStorage.removeItem('registry_token')">Logout</a>
    </header>

    <section class="section">
      <h2>\uD83D\uDD17 MCP Endpoint</h2>
      <p class="desc">Use this URL to connect any MCP-compatible agent.</p>
      <div class="cb">
        <code id="mcp-url">${h(mcpUrl)}</code>
        <button class="btn-copy" onclick="navigator.clipboard.writeText(document.getElementById('mcp-url').textContent);this.textContent='\u2713 Copied';setTimeout(()=>this.textContent='Copy',2000)">Copy</button>
      </div>
    </section>

    <section class="section">
      <h2>\uD83D\uDE80 Quick Setup</h2>
      <div class="sg">
        <div class="sc">
          <h3>Claude Code</h3>
          <div class="cbl">
            <code>${h(claudeCmd)}</code>
            <button class="btn-copy" onclick="navigator.clipboard.writeText(${JSON.stringify(claudeCmd)});this.textContent='\u2713 Copied';setTimeout(()=>this.textContent='Copy',2000)">Copy</button>
          </div>
        </div>
        <div class="sc">
          <h3>Claude Desktop</h3>
          <p class="hint">Add to <code>claude_desktop_config.json</code>:</p>
          <div class="cbl">
            <code>${h(desktopJson)}</code>
            <button class="btn-copy" onclick="navigator.clipboard.writeText(${JSON.stringify(desktopJson)});this.textContent='\u2713 Copied';setTimeout(()=>this.textContent='Copy',2000)">Copy</button>
          </div>
        </div>
        <div class="sc">
          <h3>Cursor</h3>
          <p class="hint">Settings \u2192 MCP \u2192 Add Server \u2192 paste URL</p>
          <div class="cbl">
            <code>${h(mcpUrl)}</code>
            <button class="btn-copy" onclick="navigator.clipboard.writeText(document.getElementById('mcp-url').textContent);this.textContent='\u2713 Copied';setTimeout(()=>this.textContent='Copy',2000)">Copy</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>
</body></html>`;
}
