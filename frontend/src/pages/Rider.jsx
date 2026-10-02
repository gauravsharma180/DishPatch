import { useCallback, useEffect, useRef, useState } from 'react';
import { api, rupees, STATUS_LABEL } from '../lib/api.js';
import { getSocket, useSocketEvent } from '../lib/socket.js';
import CityMap from '../components/CityMap.jsx';

const STEP_M = 60; // metres per GPS tick when auto-riding (~216 km/h, sped up for demos)

function stepToward([lat, lng], [tLat, tLng], step) {
  const dy = (tLat - lat) * 111_000;
  const dx = (tLng - lng) * 111_000 * Math.cos((lat * Math.PI) / 180);
  const d = Math.hypot(dx, dy);
  if (d <= step) return { pos: [tLat, tLng], arrived: true };
  const f = step / d;
  return { pos: [lat + (tLat - lat) * f, lng + (tLng - lng) * f], arrived: false };
}

export default function Rider() {
  const [me, setMe] = useState(null);
  const [pos, setPos] = useState(null);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState(null);
  const posRef = useRef(null);

  const load = useCallback(
    () =>
      api('/drivers/me')
        .then((d) => {
          setMe(d);
          setPos((p) => p || [d.lat, d.lng]);
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  posRef.current = pos;

  useSocketEvent('assignment:new', load);
  useSocketEvent('assignment:removed', load);
  useSocketEvent('order:updated', load);

  const active = me?.activeOrders || [];
  const current = active.find((o) => o.status === 'PICKED_UP') || active[0];
  const target = current ? (current.status === 'PICKED_UP' ? [current.delivery_lat, current.delivery_lng] : [current.restaurant_lat, current.restaurant_lng]) : null;

  // Simulated GPS: move toward the current target and stream positions over the socket.
  useEffect(() => {
    if (!auto || !target || me?.status !== 'ONLINE') return undefined;
    const t = setInterval(() => {
      const s = stepToward(posRef.current, target, STEP_M);
      setPos(s.pos);
      getSocket()?.emit('driver:location', { lat: s.pos[0], lng: s.pos[1] });
    }, 1000);
    return () => clearInterval(t);
  }, [auto, target?.[0], target?.[1], me?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleOnline() {
    setError(null);
    try {
      const status = me.status === 'ONLINE' ? 'OFFLINE' : 'ONLINE';
      await api('/drivers/me/status', { method: 'POST', body: { status, lat: pos[0], lng: pos[1] } });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function act(o, path, body) {
    setError(null);
    try {
      await api(`/orders/${o.id}/${path}`, { method: 'POST', body });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (!me) return <p className="muted pad">{error || 'Loading…'}</p>;

  const markers = [
    ...(pos ? [{ id: 'me', kind: active.length ? 'riderBusy' : 'rider', pos, label: 'You' }] : []),
    ...active.flatMap((o) => [
      { id: `k${o.id}`, kind: 'kitchen', pos: [o.restaurant_lat, o.restaurant_lng], label: o.restaurant_name },
      { id: `h${o.id}`, kind: 'home', pos: [o.delivery_lat, o.delivery_lng], label: 'Drop' },
    ]),
  ];

  return (
    <div className="split">
      <section className="pane">
        <div className="rider-status">
          <div>
            <h1>{me.status === 'ONLINE' ? 'You’re online' : 'You’re offline'}</h1>
            <p className="muted">
              {me.status === 'ONLINE'
                ? `Carrying ${me.active_orders} of ${me.max_orders} orders. New jobs arrive automatically.`
                : 'Go online to start receiving orders near you.'}
            </p>
          </div>
          <button className={`btn ${me.status === 'ONLINE' ? 'ghost' : 'primary'}`} onClick={toggleOnline}>
            {me.status === 'ONLINE' ? 'Go offline' : 'Go online'}
          </button>
        </div>

        <label className="toggle">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Simulate riding (moves you toward the next stop and streams GPS)
        </label>

        {active.length === 0 && <p className="empty">No orders yet. Stay online near busy kitchens.</p>}
        <ul className="list">
          {active.map((o) => (
            <li key={o.id} className="job">
              <div className="row-main">
                <strong>{o.restaurant_name}</strong>
                <span className="muted">
                  {STATUS_LABEL[o.status]}, {rupees(o.total_paise)}
                </span>
              </div>
              <div className="job-actions">
                {o.status === 'READY' && (
                  <button className="btn primary" onClick={() => act(o, 'transition', { to: 'PICKED_UP' })}>
                    Picked up
                  </button>
                )}
                {o.status === 'PICKED_UP' && (
                  <button className="btn primary" onClick={() => act(o, 'transition', { to: 'DELIVERED' })}>
                    Delivered
                  </button>
                )}
                {['ACCEPTED', 'PREPARING'].includes(o.status) && <span className="muted">Kitchen is cooking</span>}
                {o.status !== 'PICKED_UP' && (
                  <button className="btn ghost" onClick={() => act(o, 'reject-assignment')}>
                    Decline
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
      </section>
      <CityMap markers={markers} route={pos && target ? [pos, target] : undefined} fit={[[me.lat, me.lng], ...(target ? [target] : [])]} />
    </div>
  );
}
