import { useState } from 'react';

interface LoginProps {
  onLogin: (token: string) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [tenantId, setTenantId] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'auth' | 'tenant'>('auth');
  const [email, setEmail] = useState('');

  const handleGoogleLogin = () => {
    // TODO: Replace with real Google OAuth
    // For now, simulate with email input
    setStep('tenant');
  };

  const handleCreateTenant = async () => {
    if (!tenantId.trim()) return;
    setLoading(true);
    try {
      const apiBase = import.meta.env.VITE_API_URL || '';
      // Create tenant via @auth agent
      const res = await fetch(`${apiBase}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'tools/call',
          params: {
            name: 'call_agent',
            arguments: {
              request: {
                action: 'execute_tool',
                path: '@auth',
                tool: 'create_tenant',
                params: { name: tenantId, email },
              },
            },
          },
        }),
      });
      const data = await res.json();
      const result = JSON.parse(data?.result?.content?.[0]?.text ?? '{}');
      if (result.token) {
        onLogin(result.token);
      } else if (result.result?.token) {
        onLogin(result.result.token);
      } else {
        alert('Failed to create tenant: ' + JSON.stringify(result));
      }
    } catch (err) {
      alert('Error: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="card login-card">
        <div className="logo">
          <span className="logo-icon">⬡</span>
          <h1>Agent Registry</h1>
        </div>
        <p className="subtitle">
          Connect your AI agents to any API. Set up integrations, manage
          credentials securely, and get an MCP endpoint for Claude, Cursor, and
          more.
        </p>

        {step === 'auth' ? (
          <>
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
            <button
              className="btn btn-google"
              onClick={handleGoogleLogin}
              disabled={!email}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" className="google-icon">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </button>
          </>
        ) : (
          <>
            <label className="field-label">Choose a registry name</label>
            <input
              type="text"
              placeholder="my-company"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="input"
              autoFocus
            />
            <p className="hint">This will be your workspace identifier.</p>
            <button
              className="btn btn-primary"
              onClick={handleCreateTenant}
              disabled={loading || !tenantId}
            >
              {loading ? 'Creating...' : 'Create Registry'}
            </button>
          </>
        )}

        <p className="footer-text">
          By continuing, you agree to our terms of service.
        </p>
      </div>
    </div>
  );
}
