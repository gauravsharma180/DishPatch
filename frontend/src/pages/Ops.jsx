import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, STATUS_LABEL, timeAgo } from '../lib/api.js';
import { useSocketEvent } from '../lib/socket.js';
import CityMap from '../components/CityMap.jsx';

const FLOW = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED'];

export default function Ops() {
  const [overview, setOverview] = useState(null);
  const [drivers, setDrivers] = useState(new Map());
  const [decisions, setDecisions] = useState([]);
  const [feed, setFeed] = useState([]);

  const refresh = useCallback(async () => {
    const [o, d, log] = await Promise.all([api('/admin/overview'), api('/admin/drivers/live'), api('/admin/dispatch-log')]);
    setOverview(o);
    setDrivers(new Map(d.map((x) => [x.id, x])));
    setDecisions(log.slice(0, 12));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const push = (text, orderId) => setFeed((f) => [{ text, orderId, at: Date.now(), k: Math.random() }, ...f].slice(0, 40));

  useSocketEvent('driver:location', (p) =>
    setDrivers((m) => {
      const prev = m.get(p.driverId);
      if (!prev) return m;
      const next = new Map(m);
      next.set(p.driverId, { ...prev, lat: p.lat, lng: p.lng });
      return next;
    }),
  );
  useSocketEvent('order:new', (o) => push(`New order at ${o.restaurant_name}`, o.id));
  useSocketEvent('order:updated', (o) =>
    push(
      o.status === 'ACCEPTED' && o.driver_id && o.dispatch_state === 'ASSIGNED'
        ? `${o.driver_name} assigned to ${o.restaurant_name}`
        : `${o.restaurant_name}: ${STATUS_LABEL[o.status]}`,
      o.id,
    ),
  );
  useSocketEvent('dispatch:failed', (p) => push(`No rider found after ${p.attempt} tries`, p.orderId));

  const markers = [...drivers.values()].map((d) => ({
    id: `d${d.id}`,
    kind: d.active === 0 ? 'rider' : d.active >= d.max ? 'riderFull' : 'riderBusy',
    pos: [d.lat, d.lng],
    label: `Rider #${d.id}, ${d.active}/${d.max} orders`,
  }));

  const o = overview;
  const online = o?.drivers?.ONLINE?.count ?? 0;
  const load = o?.drivers?.ONLINE?.load ?? 0;

  return (
    <div className="ops">
      <section className="ops-side">
        <h1>City operations</h1>
        {o && (
          <>
            <div className="flowbar" aria-label="Orders by stage">
              {FLOW.map((s) => (
                <div key={s} className="flowbar-cell">
                  <span className="n">{o.orders[s] || 0}</span>
                  <span className="muted">{STATUS_LABEL[s]}</span>
                </div>
              ))}
            </div>
            <dl className="facts">
              <div>
                <dt>Riders online</dt>
                <dd>
                  {online} <span className="muted">carrying {load} orders</span>
                </dd>
              </div>
              <div>
                <dt>Waiting for a rider</dt>
                <dd>{o.queueDepth}</dd>
              </div>
              <div>
                <dt>Avg pickup distance (24h)</dt>
                <dd>{o.dispatch.avg_pickup_distance_m ?? '–'} m</dd>
              </div>
              <div>
                <dt>Avg dispatch decision</dt>
                <dd>{o.dispatch.avg_decision_ms ?? '–'} ms</dd>
              </div>
              <div>
                <dt>Unassignable orders</dt>
                <dd className={o.dispatch.failed ? 'bad' : ''}>{o.dispatch.failed}</dd>
              </div>
            </dl>
          </>
        )}

        <h2>Latest dispatch decisions</h2>
        <table className="decisions">
          <thead>
            <tr>
              <th>Order</th>
              <th>Result</th>
              <th>Rider</th>
              <th>Pickup</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/orders/${d.order_id}`}>{d.order_id.slice(0, 6)}</Link>
                </td>
                <td className={d.outcome === 'ASSIGNED' ? '' : 'bad'}>{d.outcome === 'ASSIGNED' ? 'Assigned' : d.outcome === 'NO_CANDIDATES' ? 'Retrying' : 'Failed'}</td>
                <td>{d.driver_id ? `#${d.driver_id}` : '–'}</td>
                <td>{d.distance_m ? `${Math.round(d.distance_m)} m, ${Math.round(d.eta_sec / 60)} min` : `${d.candidates} in ${d.radius_km} km`}</td>
                <td>{d.score ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="ops-map">
        <CityMap markers={markers} zoom={12} />
        <div className="legend">
          <span>
            <i className="pin pin-rider" /> Free
          </span>
          <span>
            <i className="pin pin-rider busy" /> Carrying
          </span>
          <span>
            <i className="pin pin-rider full" /> Full
          </span>
        </div>
      </section>

      <section className="feed">
        <h2>Live</h2>
        {feed.length === 0 && <p className="empty">Events show up here as orders move. Run the simulator to see the city busy.</p>}
        <ul>
          {feed.map((e) => (
            <li key={e.k}>
              <span>{e.text}</span>
              <span className="muted">{timeAgo(e.at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
