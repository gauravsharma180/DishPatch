import { useState } from 'react';
import { api } from '../lib/api.js';

const DEMOS = [
  { email: 'customer1@foodflow.dev', role: 'Customer', does: 'Browse nearby kitchens, order, track the rider live' },
  { email: 'owner1@foodflow.dev', role: 'Kitchen', does: 'Accept tickets, cook, mark ready, manage stock' },
  { email: 'driver1@foodflow.dev', role: 'Rider', does: 'Go online, take assignments, stream GPS' },
  { email: 'admin@foodflow.dev', role: 'Ops', does: 'Watch the fleet, dispatch decisions and order flow' },
];

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('customer1@foodflow.dev');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e, override) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api('/auth/login', { method: 'POST', body: { email: override || email, password } }));
    } catch (err) {
      setError(err.status === 401 ? 'That email and password don’t match a FoodFlow account.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-hero">
        <h1>
          Order in.
          <br />
          Rider out.
          <br />
          Every step on the rail.
        </h1>
        <p>
          FoodFlow follows a meal from the customer’s tap to the doorstep: kitchens get tickets in real time, the
          dispatcher picks the best nearby rider, and everyone watches the same order move.
        </p>
      </section>

      <section className="login-panel">
        <h2>Pick a seat</h2>
        <p className="muted">Each demo account sees a different side of the same live system. Password is password123.</p>
        <div className="demo-list">
          {DEMOS.map((d) => (
            <button key={d.email} className="demo" disabled={busy} onClick={() => submit(null, d.email)}>
              <strong>{d.role}</strong>
              <span>{d.does}</span>
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="login-form">
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}
