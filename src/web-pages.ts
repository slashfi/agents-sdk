const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;background:#f9f8f7;color:#1a1917;-webkit-font-smoothing:antialiased}a{color:#c4982a;text-decoration:none}.page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border:1px solid #e4ddd6;border-radius:10px;padding:32px;max-width:440px;width:100%;box-shadow:0 4px 6px -2px rgba(21,20,15,.1)}.logo{display:flex;align-items:center;gap:10px;margin-bottom:12px}.logo h1{font-size:20px;font-weight:600;letter-spacing:-.02em}.sub{color:#6b6560;font-size:14px;line-height:1.5;margin-bottom:28px}input[type=text]{width:100%;padding:10px 14px;background:#fff;border:1px solid #e4ddd6;border-radius:8px;color:#1a1917;font-size:14px;outline:none;margin-bottom:12px}input:focus{border-color:#c4982a;box-shadow:0 0 0 3px rgba(196,152,42,.08)}input::placeholder{color:#9c958e}label{display:block;font-size:13px;font-weight:500;color:#6b6560;margin-bottom:6px}.hint{font-size:12px;color:#9c958e;margin-bottom:16px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;width:100%;transition:all .15s}.btn-primary{background:#1a1917;color:#fff}.btn-primary:hover{background:#2d2c28}.btn-google{background:#fff;color:#1a1917;border:1px solid #e4ddd6}.btn-google:hover{background:#f4f3f1}.btn-ghost{background:transparent;color:#6b6560;border:1px solid #e4ddd6;padding:6px 16px;width:auto;font-size:13px}.btn-copy{background:#f4f3f1;color:#6b6560;border:1px solid #e4ddd6;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap}.btn-copy:hover{background:rgba(196,152,42,.08);color:#c4982a}.footer{text-align:center;font-size:12px;color:#9c958e;margin-top:20px}.dash{max-width:720px;width:100%}.dh{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}.sec{background:#fff;border:1px solid #e4ddd6;border-radius:10px;padding:24px;margin-bottom:16px;box-shadow:0 1px 1px rgba(21,20,15,.05)}.sec h2{font-size:15px;font-weight:600;margin-bottom:4px}.sec .d{font-size:13px;color:#6b6560;margin-bottom:16px}.cb{display:flex;align-items:center;gap:8px;background:#f4f3f1;border:1px solid #e4ddd6;border-radius:8px;padding:10px 14px}.cb code{flex:1;font-size:13px;font-family:'SF Mono',Menlo,monospace;word-break:break-all}.sg{display:grid;gap:12px}.sc{background:#f4f3f1;border:1px solid #e4ddd6;border-radius:8px;padding:16px}.sc h3{font-size:14px;font-weight:600;margin-bottom:8px}.cbl{display:flex;align-items:flex-start;gap:8px;background:#fff;border:1px solid #e4ddd6;border-radius:6px;padding:10px 12px}.cbl code{flex:1;font-size:12px;font-family:'SF Mono',Menlo,monospace;white-space:pre-wrap;word-break:break-all;color:#6b6560}.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:16px}.avatar{width:32px;height:32px;border-radius:50%;border:1px solid #e4ddd6}`;

const googleSvg = `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 2.58 9 3.58z" fill="#EA4335"/></svg>`;

function h(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title>
<style>${css}</style></head>
<body>${body}</body></html>`;
}

export function renderLoginPage(_baseUrl: string, googleEnabled: boolean): string {
  const googleBtn = googleEnabled
    ? `<a href="/auth/google" class="btn btn-google">${googleSvg} Continue with Google</a>`
    : `<p style="color:#9c958e;font-size:13px;text-align:center;padding:12px 0">Google OAuth not configured.<br>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.</p>`;

  return wrap("Agent Registry", `
<div class="page">
  <div class="card">
    <div class="logo"><span style="font-size:24px">\u2B21</span><h1>Agent Registry</h1></div>
    <p class="sub">Connect your AI agents to any API. Set up integrations, manage credentials securely, and get an MCP endpoint for Claude, Cursor, and more.</p>
    ${googleBtn}
    <p class="footer">By continuing, you agree to our terms of service.</p>
  </div>
</div>`);
}

export function renderTenantPage(_baseUrl: string, email: string, name: string): string {
  return wrap("Create Registry — Agent Registry", `
<div class="page">
  <div class="card">
    <div class="logo"><span style="font-size:24px">\u2B21</span><h1>Agent Registry</h1></div>
    <p class="sub">Welcome, ${h(name || email)}! Choose a name for your registry.</p>
    <div id="err" class="err" style="display:none"></div>
    <form id="f">
      <input type="hidden" name="email" value="${h(email)}">
      <label>Registry name</label>
      <input type="text" name="tenant" placeholder="my-company" required pattern="[a-z0-9-]+" autocomplete="off" autofocus>
      <p class="hint">Lowercase letters, numbers, and hyphens only.</p>
      <button type="submit" class="btn btn-primary">Create Registry</button>
    </form>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const r = await fetch('/setup', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email: fd.get('email'), tenant: fd.get('tenant') }) });
    const d = await r.json();
    if (d.token || d.result?.token) {
      window.location.href = '/dashboard?token=' + (d.token || d.result.token);
    } else {
      const el = document.getElementById('err');
      el.textContent = d.error || JSON.stringify(d);
      el.style.display = 'block';
    }
  } catch(err) { document.getElementById('err').textContent = err.message; document.getElementById('err').style.display = 'block'; }
  finally { btn.disabled = false; btn.textContent = 'Create Registry'; }
});
</script>`);
}

export function renderDashboardPage(baseUrl: string, token: string): string {
  const mcpUrl = `${baseUrl}/mcp?token=${h(token)}`;
  const claudeCmd = `claude mcp add agent-registry ${mcpUrl}`;
  const desktopJson = JSON.stringify({ mcpServers: { "agent-registry": { url: mcpUrl } } }, null, 2);
  const cpFn = `function cp(id){navigator.clipboard.writeText(document.getElementById(id).textContent);event.target.textContent='\u2713 Copied';setTimeout(()=>event.target.textContent='Copy',2000)}`;

  return wrap("Dashboard — Agent Registry", `
<div class="page">
  <div class="dash">
    <header class="dh">
      <div class="logo"><span style="font-size:24px">\u2B21</span><h1>Agent Registry</h1></div>
      <a href="/" class="btn btn-ghost">Logout</a>
    </header>

    <section class="sec">
      <h2>\uD83D\uDD17 MCP Endpoint</h2>
      <p class="d">Use this URL to connect any MCP-compatible agent.</p>
      <div class="cb">
        <code id="mcp">${h(mcpUrl)}</code>
        <button class="btn-copy" onclick="cp('mcp')">Copy</button>
      </div>
    </section>

    <section class="sec">
      <h2>\uD83D\uDE80 Quick Setup</h2>
      <div class="sg">
        <div class="sc">
          <h3>Claude Code</h3>
          <div class="cbl"><code id="cc">${h(claudeCmd)}</code><button class="btn-copy" onclick="cp('cc')">Copy</button></div>
        </div>
        <div class="sc">
          <h3>Claude Desktop</h3>
          <p class="hint">Add to claude_desktop_config.json:</p>
          <div class="cbl"><code id="cd">${h(desktopJson)}</code><button class="btn-copy" onclick="cp('cd')">Copy</button></div>
        </div>
        <div class="sc">
          <h3>Cursor</h3>
          <p class="hint">Settings \u2192 MCP \u2192 Add Server \u2192 paste URL</p>
          <div class="cbl"><code id="cu">${h(mcpUrl)}</code><button class="btn-copy" onclick="cp('cu')">Copy</button></div>
        </div>
      </div>
    </section>
  </div>
</div>
<script>${cpFn}</script>`);
}
