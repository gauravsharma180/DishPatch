import { rupees, STATUS_LABEL, timeAgo } from '../lib/api.js';

/**
 * An order rendered like a kitchen order ticket (KOT) torn off a thermal printer.
 * The ticket is the one visual signature of the app; everything around it stays plain.
 */
export default function Ticket({ order, items, actions, highlight, children }) {
  return (
    <article className={`ticket status-${order.status} ${highlight ? 'flash' : ''}`}>
      <div className="ticket-head">
        <span className="ticket-no">#{order.id.slice(0, 6).toUpperCase()}</span>
        <span className="ticket-time">{timeAgo(order.created_at)}</span>
      </div>
      <div className="ticket-status">{STATUS_LABEL[order.status]}</div>
      {items && (
        <ul className="ticket-items">
          {items.map((i) => (
            <li key={i.menu_item_id}>
              <span>
                {i.qty} × {i.name}
              </span>
              <span>{rupees(i.price_paise * i.qty)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="ticket-total">
        <span>Total</span>
        <span>{rupees(order.total_paise)}</span>
      </div>
      <div className="ticket-rider">
        {order.driver_id ? (
          <>Rider: {order.driver_name || `#${order.driver_id}`}</>
        ) : order.dispatch_state === 'SEARCHING' || order.dispatch_state === 'PENDING' ? (
          order.status === 'PLACED' ? 'Rider: assigned after you accept' : 'Rider: searching nearby…'
        ) : order.dispatch_state === 'FAILED' && !['CANCELLED', 'REJECTED'].includes(order.status) ? (
          'Rider: none available, ops alerted'
        ) : null}
      </div>
      {children}
      {actions && <div className="ticket-actions">{actions}</div>}
    </article>
  );
}
