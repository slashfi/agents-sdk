import { useState, useEffect } from 'react';

interface DashboardProps {
  token: string;
  onLogout: () => void;
}

interface Credentials {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  mcpUrl?: string;
}

export default function Dashboard({ token, onLogout }: DashboardProps) {
  const [creds, setCreds] = useState<Credentials>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const origin = import.meta.env.VITE_API_URL || window.location.origin;
  const mcpUrl = `${origin}/mcp?token=${token}`;

  useEffect(() => {
    // Fetch tenant credentials
    (async () => {
      try {
        const res = await fetch(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'tools/call',
            params: {
              name: 'call_agent',
              arguments: {
                request: {
                  action: 'execute_tool',
                  path: '@auth',
                  tool: 'whoami',
                  params: {},
                },
              },
            },
          }),
        });
        const data = await res.json();
        const result = JSON.parse(data?.result?.content?.[0]?.text ?? '{}');
        setCreds({
          clientId: result.result?.clientId ?? result.clientId,
          clientSecret: result.result?.clientSecret ?? result.clientSecret,
          tenantId: result.result?.tenantId ?? result.tenantId,
          mcpUrl,
        });
      } catch {
        // Token might be a root key, just show MCP URL
        setCreds({ mcpUrl });
      }
    })();
  }, [token, origin, mcpUrl]);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const CopyButton = ({ text, label }: { text: string; label: string }) => (
    <button className="btn-copy" onClick={() => copy(text, label)}>
      {copied === label ? '✓ Copied' : 'Copy'}
    </button>
  );

  return (
    <div className="page">
      <div className="dashboard">
        <header className="dash-header">
          <div className="logo">
            <span className="logo-icon">⬡</span>
            <h1>Agent Registry</h1>
          </div>
          <button className="btn btn-ghost" onClick={onLogout}>Logout</button>
        </header>

        {/* MCP URL */}
        <section className="section">
          <h2>🔗 MCP Endpoint</h2>
          <p className="desc">Use this URL to connect any MCP-compatible agent.</p>
          <div className="credential-box">
            <code className="credential-value">{mcpUrl}</code>
            <CopyButton text={mcpUrl} label="mcp" />
          </div>
        </section>

        {/* Setup Instructions */}
        <section className="section">
          <h2>🚀 Quick Setup</h2>
          <div className="setup-grid">
            <div className="setup-card">
              <h3>Claude Code</h3>
              <div className="code-block">
                <code>claude mcp add slash-registry {mcpUrl}</code>
                <CopyButton text={`claude mcp add slash-registry ${mcpUrl}`} label="claude-code" />
              </div>
            </div>

            <div className="setup-card">
              <h3>Claude Desktop</h3>
              <p className="hint">Add to <code>claude_desktop_config.json</code>:</p>
              <div className="code-block">
                <code>{JSON.stringify({ mcpServers: { "slash-registry": { url: mcpUrl } } }, null, 2)}</code>
                <CopyButton
                  text={JSON.stringify({ mcpServers: { "slash-registry": { url: mcpUrl } } }, null, 2)}
                  label="claude-desktop"
                />
              </div>
            </div>

            <div className="setup-card">
              <h3>Cursor</h3>
              <p className="hint">Settings → MCP → Add Server → paste URL</p>
              <div className="code-block">
                <code>{mcpUrl}</code>
                <CopyButton text={mcpUrl} label="cursor" />
              </div>
            </div>
          </div>
        </section>

        {/* API Credentials */}
        {creds.clientId && (
          <section className="section">
            <h2>🔑 API Credentials</h2>
            <p className="desc">For server-to-server OAuth2 client_credentials flow.</p>
            <div className="cred-grid">
              <div>
                <label className="field-label">Client ID</label>
                <div className="credential-box">
                  <code className="credential-value">{creds.clientId}</code>
                  <CopyButton text={creds.clientId} label="client-id" />
                </div>
              </div>
              <div>
                <label className="field-label">Client Secret</label>
                <div className="credential-box">
                  <code className="credential-value">
                    {showSecret ? creds.clientSecret : '•'.repeat(32)}
                  </code>
                  <button className="btn-copy" onClick={() => setShowSecret(!showSecret)}>
                    {showSecret ? 'Hide' : 'Show'}
                  </button>
                  {creds.clientSecret && <CopyButton text={creds.clientSecret} label="client-secret" />}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
