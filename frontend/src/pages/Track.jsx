import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, getSession } from '../lib/api.js';
import { useOrderRoom, useSocketEvent } from '../lib/socket.js';
import CityMap from '../components/CityMap.jsx';
import Ticket from '../components/Ticket.jsx';
import Timeline from '../components/Timeline.jsx';

export default function Track() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [rider, setRider] = useState(null); // live [lat,lng]
  const [error, setError] = useState(null);
  const isCustomer = getSession()?.user.role === 'CUSTOMER';

  const load = useCallback(() => {
    api(`/orders/${id}`)
      .then((o) => {
        setOrder(o);
        if (o.driver_lat) setRider((r) => r || [o.driver_lat, o.driver_lng]);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);
  useOrderRoom(id);

  // Status pushes carry the order row; re-fetch to get the event trail too.
  useSocketEvent('order:updated', (o) => {
    if (o.id === id) load();
  });
  useSocketEvent('driver:location', (p) => {
    if (order?.driver_id && p.driverId === order.driver_id) setRider([p.lat, p.lng]);
  });

  if (error) return <p className="error pad">{error}</p>;
  if (!order) return <p className="muted pad">Loading order…</p>;

  const kitchen = [order.restaurant_lat, order.restaurant_lng];
  const home = [order.delivery_lat, order.delivery_lng];
  const target = order.status === 'PICKED_UP' ? home : kitchen;
  const markers = [
    { id: 'k', kind: 'kitchen', pos: kitchen, label: order.restaurant_name },
    { id: 'h', kind: 'home', pos: home, label: 'Delivery point' },
    ...(rider && order.status !== 'DELIVERED' ? [{ id: 'd', kind: 'riderBusy', pos: rider, label: order.driver_name }] : []),
  ];

  const cancellable = isCustomer && order.status === 'PLACED';

  return (
    <div className="split">
      <section className="pane">
        <h1>{order.restaurant_name}</h1>
        <Timeline status={order.status} events={order.events} />
        <Ticket
          order={order}
          items={order.items}
          actions={
            cancellable && (
              <button
                className="btn danger"
                onClick={() => api(`/orders/${id}/transition`, { method: 'POST', body: { to: 'CANCELLED' } }).then(load)}
              >
                Cancel order
              </button>
            )
          }
        />
      </section>
      <CityMap
        markers={markers}
        route={rider && !['DELIVERED', 'CANCELLED', 'REJECTED'].includes(order.status) ? [rider, target] : undefined}
        fit={[kitchen, home]}
      />
    </div>
  );
}
