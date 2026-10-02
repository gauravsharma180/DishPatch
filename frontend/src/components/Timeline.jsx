import { STATUS_LABEL } from '../lib/api.js';

const PATH = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED'];

/** The lifecycle as an ordered rail; this one IS a sequence, so it's numbered by position. */
export default function Timeline({ status, events = [] }) {
  const at = Object.fromEntries(events.map((e) => [e.to_status, e.created_at]));
  const stopped = ['CANCELLED', 'REJECTED'].includes(status);
  const idx = PATH.indexOf(status);
  return (
    <ol className="timeline">
      {PATH.map((s, i) => {
        const state = stopped ? (at[s] ? 'done' : 'skipped') : i < idx ? 'done' : i === idx ? 'current' : 'todo';
        return (
          <li key={s} className={state}>
            <span className="dot" />
            <span className="label">{STATUS_LABEL[s]}</span>
            <span className="when">{at[s] ? new Date(at[s]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}</span>
          </li>
        );
      })}
      {stopped && (
        <li className="current stopped">
          <span className="dot" />
          <span className="label">{STATUS_LABEL[status]}</span>
          <span className="when">{at[status] ? new Date(at[status]).toLocaleTimeString() : ''}</span>
        </li>
      )}
    </ol>
  );
}
