import { useCallback, useEffect, useState } from 'react';
import { api, rupees } from '../lib/api.js';
import { useSocketEvent } from '../lib/socket.js';
import Ticket from '../components/Ticket.jsx';

const ACTIVE = 'PLACED,ACCEPTED,PREPARING,READY,PICKED_UP';
const ACTIVE_SET = new Set(ACTIVE.split(','));

const COLUMNS = [
  { title: 'New', statuses: ['PLACED'], empty: 'New orders print here the moment a customer pays.' },
  { title: 'Cooking', statuses: ['ACCEPTED', 'PREPARING'], empty: 'Accepted tickets wait here while the food is made.' },
  { title: 'Ready', statuses: ['READY'], empty: 'Mark a ticket ready when it’s packed for the rider.' },
  { title: 'With rider', statuses: ['PICKED_UP'], empty: 'Picked-up orders show here until delivered.' },
];

const NEXT = {
  PLACED: [
    ['ACCEPTED', 'Accept', 'primary'],
    ['REJECTED', 'Reject', 'danger'],
  ],
  ACCEPTED: [
    ['PREPARING', 'Start cooking', 'primary'],
    ['CANCELLED', 'Cancel', 'danger'],
  ],
  PREPARING: [
    ['READY', 'Mark ready', 'primary'],
    ['CANCELLED', 'Cancel', 'danger'],
  ],
};

export default function Kitchen({ session }) {
  const rid = session.user.restaurantId;
  const [orders, setOrders] = useState([]);
  const [fresh, setFresh] = useState(new Set());
  const [stock, setStock] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(() => api(`/orders?status=${ACTIVE}&limit=100`).then(setOrders), []);
  const loadStock = useCallback(() => api(`/restaurants/${rid}/inventory`).then(setStock), [rid]);
  useEffect(() => {
    load();
    loadStock();
  }, [load, loadStock]);

  const upsert = (o) =>
    setOrders((list) => {
      const rest = list.filter((x) => x.id !== o.id);
      return ACTIVE_SET.has(o.status) ? [o, ...rest] : rest;
    });

  useSocketEvent('order:new', (o) => {
    upsert(o);
    setFresh((s) => new Set(s).add(o.id));
    setTimeout(() => setFresh((s) => ((s = new Set(s)), s.delete(o.id), s)), 2500);
    loadStock();
  });
  useSocketEvent('order:updated', upsert);

  async function move(o, to) {
    setError(null);
    try {
      upsert(await api(`/orders/${o.id}/transition`, { method: 'POST', body: { to } }));
      if (to === 'CANCELLED' || to === 'REJECTED') loadStock();
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveStock(item, value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n === item.stock) return;
    await api(`/restaurants/${rid}/menu/${item.id}`, { method: 'PATCH', body: { stock: n } });
    loadStock();
  }

  return (
    <div className="kitchen">
      <div className="rail">
        {COLUMNS.map((col) => {
          const list = orders.filter((o) => col.statuses.includes(o.status));
          return (
            <section key={col.title} className="rail-col">
              <h2>
                {col.title} <span className="count">{list.length}</span>
              </h2>
              {list.length === 0 && <p className="empty">{col.empty}</p>}
              {list.map((o) => (
                <Ticket
                  key={o.id}
                  order={o}
                  items={o.items}
                  highlight={fresh.has(o.id)}
                  actions={(NEXT[o.status] || []).map(([to, label, tone]) => (
                    <button key={to} className={`btn ${tone}`} onClick={() => move(o, to)}>
                      {label}
                    </button>
                  ))}
                />
              ))}
            </section>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}

      <section className="stock">
        <h2>Stock</h2>
        <p className="muted">Stock drops as orders land and comes back if an order is cancelled. Set a new count and press Enter.</p>
        <table>
          <thead>
            <tr>
              <th>Dish</th>
              <th>Price</th>
              <th>Left</th>
            </tr>
          </thead>
          <tbody>
            {stock.map((i) => (
              <tr key={i.id} className={i.stock === 0 ? 'out' : ''}>
                <td>{i.name}</td>
                <td>{rupees(i.price_paise)}</td>
                <td>
                  <input
                    aria-label={`Stock for ${i.name}`}
                    defaultValue={i.stock}
                    key={`${i.id}-${i.stock}`}
                    inputMode="numeric"
                    onKeyDown={(e) => e.key === 'Enter' && saveStock(i, e.currentTarget.value)}
                    onBlur={(e) => saveStock(i, e.currentTarget.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
