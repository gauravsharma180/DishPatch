import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { getSession } from './api.js';

let socket = null;
let socketToken = null;

/** One shared websocket per logged-in session. */
export function getSocket() {
  const token = getSession()?.token;
  if (!token) return null;
  if (socket && socketToken === token) return socket;
  socket?.close();
  socketToken = token;
  socket = io({ auth: { token }, transports: ['websocket'] });
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
  socketToken = null;
}

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent(event, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return undefined;
    const fn = (payload) => ref.current(payload);
    s.on(event, fn);
    return () => s.off(event, fn);
  }, [event]);
}

/** Join an order's room so we get its status + rider location pushes. */
export function useOrderRoom(orderId) {
  useEffect(() => {
    const s = getSocket();
    if (!s || !orderId) return undefined;
    const join = () => s.emit('order:subscribe', { orderId });
    join();
    s.on('connect', join); // re-join after reconnects
    return () => {
      s.off('connect', join);
      s.emit('order:unsubscribe', { orderId });
    };
  }, [orderId]);
}

export function useConnectionState(setState) {
  useEffect(() => {
    const s = getSocket();
    if (!s) return undefined;
    const on = () => setState(true);
    const off = () => setState(false);
    setState(s.connected);
    s.on('connect', on);
    s.on('disconnect', off);
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
    };
  }, [setState]);
}
