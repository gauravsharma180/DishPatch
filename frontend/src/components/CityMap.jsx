import { useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';

export const CITY = [12.9716, 77.5946];

const pin = (kind, label = '') =>
  L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}">${label}</div>`,
    iconSize: kind.startsWith('rider') ? [18, 18] : [26, 26],
    iconAnchor: kind.startsWith('rider') ? [9, 9] : [13, 13],
  });

const ICONS = {
  kitchen: pin('kitchen', 'K'),
  home: pin('home', 'H'),
  rider: pin('rider'),
  riderBusy: pin('rider busy'),
  riderFull: pin('rider full'),
};

function FitTo({ points }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 14);
    else if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

function ClickHandler({ onClick }) {
  useMapEvents({ click: (e) => onClick?.([e.latlng.lat, e.latlng.lng]) });
  return null;
}

/**
 * markers: [{ id, kind: 'kitchen'|'home'|'rider'|'riderBusy'|'riderFull', pos: [lat,lng], label }]
 * route:   [[lat,lng], ...] dashed line
 * fit:     points to frame once
 */
export default function CityMap({ markers = [], route, fit, onClick, zoom = 13, className = '' }) {
  return (
    <div className={`map ${className}`}>
      <MapContainer center={CITY} zoom={zoom} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />
        {fit && <FitTo points={fit} />}
        {onClick && <ClickHandler onClick={onClick} />}
        {route && route.length > 1 && <Polyline positions={route} pathOptions={{ color: '#1d3557', weight: 3, dashArray: '6 8' }} />}
        {markers.map((m) => (
          <Marker key={m.id} position={m.pos} icon={ICONS[m.kind] || ICONS.rider}>
            {m.label && <Tooltip direction="top" offset={[0, -10]}>{m.label}</Tooltip>}
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
