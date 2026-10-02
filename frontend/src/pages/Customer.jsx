import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rupees, STATUS_LABEL } from '../lib/api.js';
import CityMap, { CITY } from '../components/CityMap.jsx';

export default function Customer() {
  const navigate = useNavigate();
  const [home, setHome] = useState(CITY);
  const [restaurants, setRestaurants] = useState([]);
  const [menu, setMenu] = useState(null);
  const [cart, setCart] = useState({}); // menuItemId -> qty
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState(null);
  const [placing, setPlacing] = useState(false);
  // One Idempotency-Key per checkout attempt: a double-click or a retry after a
  // network blip reuses it, so the server creates the order at most once.
  const idemKey = useRef(crypto.randomUUID());

  useEffect(() => {
    api(`/restaurants?lat=${home[0]}&lng=${home[1]}&radiusKm=5`).then(setRestaurants).catch((e) => setError(e.message));
  }, [home]);

  useEffect(() => {
    api('/orders?limit=8').then(setOrders).catch(() => {});
  }, []);

  async function openMenu(r) {
    setError(null);
    setCart({});
    idemKey.current = crypto.randomUUID();
    setMenu(await api(`/restaurants/${r.id}/menu`));
  }

  const lines = useMemo(
    () => (menu ? menu.items.filter((i) => cart[i.id]).map((i) => ({ ...i, qty: cart[i.id] })) : []),
    [menu, cart],
  );
  const total = lines.reduce((s, l) => s + l.price_paise * l.qty, 0);

  const bump = (id, d) => {
    idemKey.current = crypto.randomUUID(); // cart changed => new logical request
    setCart((c) => {
      const q = Math.max(0, (c[id] || 0) + d);
      const next = { ...c, [id]: q };
      if (!q) delete next[id];
      return next;
    });
  };

  async function checkout() {
    setPlacing(true);
    setError(null);
    try {
      const order = await api('/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey.current },
        body: {
          restaurantId: menu.id,
          items: lines.map((l) => ({ menuItemId: l.id, qty: l.qty })),
          deliveryLat: home[0],
          deliveryLng: home[1],
          address: 'Pinned on map',
        },
      });
      navigate(`/orders/${order.id}`);
    } catch (e) {
      if (e.code === 'OUT_OF_STOCK') {
        setError(`${e.message}. Remove it from your cart to continue.`);
        setMenu(await api(`/restaurants/${menu.id}/menu`));
        idemKey.current = crypto.randomUUID();
      } else if (e.code === 'REQUEST_IN_PROGRESS') {
        setError('Your order is still being placed. Give it a second.');
      } else setError(e.message);
    } finally {
      setPlacing(false);
    }
  }

  const markers = [
    { id: 'home', kind: 'home', pos: home, label: 'Deliver here' },
    ...restaurants.map((r) => ({ id: `r${r.id}`, kind: 'kitchen', pos: [r.lat, r.lng], label: r.name })),
  ];

  return (
    <div className="split">
      <section className="pane">
        {!menu ? (
          <>
            <h1>Kitchens near you</h1>
            <p className="muted">Click the map to move your delivery pin. Showing kitchens within 5 km.</p>
            <ul className="list">
              {restaurants.map((r) => (
                <li key={r.id}>
                  <button className="row" onClick={() => openMenu(r)} disabled={!r.is_open}>
                    <span className="row-main">
                      <strong>{r.name}</strong>
                      <span className="muted">
                        {r.cuisine}, about {r.avg_prep_minutes} min to cook
                      </span>
                    </span>
                    <span className="row-side">{r.distance_km} km</span>
                  </button>
                </li>
              ))}
              {!restaurants.length && <li className="empty">No kitchens deliver to this pin. Try moving it closer to the city centre.</li>}
            </ul>

            {orders.length > 0 && (
              <>
                <h2>Your orders</h2>
                <ul className="list">
                  {orders.map((o) => (
                    <li key={o.id}>
                      <Link className="row" to={`/orders/${o.id}`}>
                        <span className="row-main">
                          <strong>{o.restaurant_name}</strong>
                          <span className="muted">{STATUS_LABEL[o.status]}</span>
                        </span>
                        <span className="row-side">{rupees(o.total_paise)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <>
            <button className="btn ghost back" onClick={() => setMenu(null)}>
              Back to kitchens
            </button>
            <h1>{menu.name}</h1>
            <p className="muted">{menu.cuisine}</p>
            <ul className="list menu">
              {menu.items.map((i) => (
                <li key={i.id} className={`menu-item ${i.in_stock ? '' : 'sold-out'}`}>
                  <span className="row-main">
                    <strong>{i.name}</strong>
                    <span className="muted">{i.in_stock ? rupees(i.price_paise) : 'Sold out'}</span>
                  </span>
                  <span className="stepper">
                    {cart[i.id] ? (
                      <>
                        <button aria-label={`Remove one ${i.name}`} onClick={() => bump(i.id, -1)}>
                          −
                        </button>
                        <span>{cart[i.id]}</span>
                      </>
                    ) : null}
                    <button aria-label={`Add ${i.name}`} disabled={!i.in_stock} onClick={() => bump(i.id, 1)}>
                      +
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="cart">
              <span>
                {lines.reduce((s, l) => s + l.qty, 0)} items, {rupees(total)}
              </span>
              <button className="btn primary" disabled={!lines.length || placing} onClick={checkout}>
                {placing ? 'Placing order…' : 'Place order'}
              </button>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </section>
      <CityMap markers={markers} onClick={setHome} fit={menu ? [home, [menu.lat, menu.lng]] : undefined} />
    </div>
  );
}
