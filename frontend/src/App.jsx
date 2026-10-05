import { useCallback, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { getSession, setSession } from './lib/api.js';
import { closeSocket, useConnectionState } from './lib/socket.js';
import Login from './pages/Login.jsx';
import Customer from './pages/Customer.jsx';
import Track from './pages/Track.jsx';
import Kitchen from './pages/Kitchen.jsx';
import Rider from './pages/Rider.jsx';
import Ops from './pages/Ops.jsx';

const HOME = { CUSTOMER: '/eat', RESTAURANT: '/kitchen', DRIVER: '/ride', ADMIN: '/ops' };
const ROLE_NAME = { CUSTOMER: 'Customer', RESTAURANT: 'Kitchen', DRIVER: 'Rider', ADMIN: 'Ops' };

function Shell({ session, onLogout, children }) {
  const [live, setLive] = useState(false);
  useConnectionState(useCallback((v) => setLive(v), []));
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={HOME[session.user.role]}>
          DishPatch
        </a>
        <span className="role-chip">{ROLE_NAME[session.user.role]}</span>
        <span className={`live ${live ? 'on' : ''}`} title={live ? 'Realtime connected' : 'Reconnecting'}>
          {live ? 'Live' : 'Offline'}
        </span>
        <span className="who">{session.user.name}</span>
        <button className="btn ghost" onClick={onLogout}>
          Sign out
        </button>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

export default function App() {
  const [session, setS] = useState(getSession());
  const navigate = useNavigate();

  const login = (s) => {
    setSession(s);
    setS(s);
    navigate(HOME[s.user.role]);
  };
  const logout = () => {
    setSession(null);
    closeSocket();
    setS(null);
    navigate('/');
  };

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login onLogin={login} />} />
      </Routes>
    );
  }

  const role = session.user.role;
  return (
    <Shell session={session} onLogout={logout}>
      <Routes>
        {role === 'CUSTOMER' && <Route path="/eat" element={<Customer />} />}
        {role === 'CUSTOMER' && <Route path="/orders/:id" element={<Track />} />}
        {role === 'RESTAURANT' && <Route path="/kitchen" element={<Kitchen session={session} />} />}
        {role === 'DRIVER' && <Route path="/ride" element={<Rider />} />}
        {role === 'ADMIN' && <Route path="/ops" element={<Ops />} />}
        {role === 'ADMIN' && <Route path="/orders/:id" element={<Track />} />}
        <Route path="*" element={<Navigate to={HOME[role]} replace />} />
      </Routes>
    </Shell>
  );
}
