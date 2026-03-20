import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import './App.css';

function App() {
  const [token, setToken] = useState<string | null>(
    localStorage.getItem('registry_token')
  );

  useEffect(() => {
    if (token) localStorage.setItem('registry_token', token);
    else localStorage.removeItem('registry_token');
  }, [token]);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            token ? <Navigate to="/dashboard" /> : <Login onLogin={setToken} />
          }
        />
        <Route
          path="/dashboard"
          element={
            token ? (
              <Dashboard token={token} onLogout={() => setToken(null)} />
            ) : (
              <Navigate to="/" />
            )
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
