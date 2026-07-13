"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair, Loader2, MapPin, Minus, Plus, X } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { emitOptimisticListBump } from "@/features/inbox/lib/optimistic-list-bump";
import { useFocusTrap } from "@/hooks/use-modal-overlay";

/**
 * Inbox-side composer to SEND a location — the outbound twin of the shared-
 * location card. The agent picks a point on an interactive map (click to place,
 * "use my location", zoom), optionally names it, and we POST
 * /api/messages/location. It renders on the thread as the same map-pin card an
 * inbound location does. Dependency-free + CSP-safe: the map is <img> tiles
 * (allowed by `img-src https:`) and geolocation is a browser API — no external
 * `fetch` (which our `connect-src` would block), so no geocoder / map library.
 */

const TILE = 256;
const TILE_URL = (z: number, x: number, y: number) =>
  `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}@2x.png`;

function project(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}
function unproject(x: number, y: number, z: number): { lat: number; lon: number } {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lon };
}

const BOX_W = 288;
const BOX_H = 180;

function PickMap({
  lat,
  lon,
  zoom,
  onPick,
}: {
  lat: number;
  lon: number;
  zoom: number;
  onPick: (lat: number, lon: number) => void;
}) {
  const n = 2 ** zoom;
  const { x, y } = project(lat, lon, zoom);
  const cx = x * TILE;
  const cy = y * TILE;
  const xt = Math.floor(x);
  const yt = Math.floor(y);
  const tiles: Array<{ tx: number; ty: number }> = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) tiles.push({ tx: xt + dx, ty: yt + dy });

  return (
    <div
      className="relative overflow-hidden rounded-md border border-border bg-muted"
      style={{ width: BOX_W, height: BOX_H }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const dx = e.clientX - rect.left - BOX_W / 2;
        const dy = e.clientY - rect.top - BOX_H / 2;
        const p = unproject((cx + dx) / TILE, (cy + dy) / TILE, zoom);
        onPick(p.lat, p.lon);
      }}
    >
      {tiles.map(({ tx, ty }) => {
        if (ty < 0 || ty >= n) return null;
        const wx = ((tx % n) + n) % n;
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${tx}_${ty}`}
            src={TILE_URL(zoom, wx, ty)}
            alt=""
            width={TILE}
            height={TILE}
            draggable={false}
            className="pointer-events-none absolute max-w-none select-none"
            style={{ left: `calc(50% + ${tx * TILE - cx}px)`, top: `calc(50% + ${ty * TILE - cy}px)` }}
          />
        );
      })}
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-full drop-shadow"
        fill="#EA4335"
        stroke="#fff"
        strokeWidth="1.5"
      >
        <path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z" />
        <circle cx="12" cy="9" r="2.5" fill="#fff" stroke="none" />
      </svg>
      <span className="pointer-events-none absolute bottom-0 right-0 bg-background/70 px-1 text-[8px] text-muted-foreground">
        © OpenStreetMap · CARTO
      </span>
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: () => void;
}

export function LocationComposer({ open, onClose, conversationId, onSent }: Props) {
  // Default view: a wide look until the agent picks / uses their location.
  const [lat, setLat] = useState(25);
  const [lon, setLon] = useState(45);
  const [zoom, setZoom] = useState(4);
  const [picked, setPicked] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // True once the agent has deliberately picked (clicked the map or the "My
  // location" button). The auto-locate on open is async (GPS can take 2-8s); if
  // the agent drops a pin while it's pending, its late success must NOT clobber
  // that pick and jump to the device location.
  const userInteractedRef = useRef(false);

  useEffect(() => {
    if (open) {
      setPicked(false);
      setName("");
      setAddress("");
      setError(null);
      userInteractedRef.current = false;
      // Default to the agent's location — request it automatically on open, and
      // silently fall back to the pick-map if denied/unavailable (they can click
      // the map or the "My location" button). Requires the geolocation
      // Permissions-Policy allowlist to include `self`.
      locate({ silent: true });
    }
  }, [open]);

  useFocusTrap(wrapperRef, open, onClose);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) onClose();
    }
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDocClick), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDocClick);
    };
  }, [open, onClose]);

  function locate({ silent }: { silent?: boolean } = {}) {
    if (!navigator.geolocation) {
      if (!silent) setError("Geolocation isn't available in this browser.");
      return;
    }
    // A manual "My location" click IS a deliberate pick; the silent auto-request
    // is not (and must yield to a pick made while it's still pending).
    if (!silent) userInteractedRef.current = true;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // A late silent auto-locate must not overwrite a pin the agent already
        // dropped (or a manual locate they kicked off after).
        if (silent && userInteractedRef.current) {
          setLocating(false);
          return;
        }
        setLat(pos.coords.latitude);
        setLon(pos.coords.longitude);
        setZoom(16);
        setPicked(true);
        setLocating(false);
      },
      () => {
        // On the auto-request we stay quiet — the agent can still click the map
        // or the button; only a manual click surfaces the "couldn't get" hint.
        if (!silent) setError("Couldn't get your location — click the map to place a pin.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  async function send() {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/messages/location", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          latitude: Number(lat.toFixed(6)),
          longitude: Number(lon.toFixed(6)),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(address.trim() ? { address: address.trim() } : {}),
          // Idempotency: a re-POST of this exact request (proxy/network retry)
          // carries the same id → the server returns the first result instead
          // of sending a second pin.
          clientTempId: crypto.randomUUID(),
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || `Send failed (HTTP ${res.status})`);
      }
      emitOptimisticListBump({
        conversationId,
        preview: name.trim() ? `📍 ${name.trim()}` : "📍 Location",
        lastMessageAt: new Date().toISOString(),
      });
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div
      ref={wrapperRef}
      role="dialog"
      aria-modal="true"
      aria-label="Send a location"
      tabIndex={-1}
      className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-[20rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-3 shadow-xl focus:outline-none animate-slide-up"
    >
      <div className="mb-2 flex items-center gap-2">
        <MapPin className="size-4 text-info-fg" />
        <div className="text-sm font-semibold">Send a location</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="relative">
        <PickMap
          lat={lat}
          lon={lon}
          zoom={zoom}
          onPick={(la, lo) => {
            userInteractedRef.current = true;
            setLat(la);
            setLon(lo);
            setPicked(true);
            if (zoom < 15) setZoom(15);
          }}
        />
        {/* zoom + locate controls */}
        <div className="absolute right-1.5 top-1.5 flex flex-col gap-1">
          <IconBtn label="Zoom in" onClick={() => setZoom((z) => Math.min(19, z + 1))}>
            <Plus className="size-3.5" />
          </IconBtn>
          <IconBtn label="Zoom out" onClick={() => setZoom((z) => Math.max(2, z - 1))}>
            <Minus className="size-3.5" />
          </IconBtn>
        </div>
        <button
          type="button"
          onClick={() => locate()}
          className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-2xs font-medium text-foreground shadow transition hover:bg-background"
        >
          {locating ? <Loader2 className="size-3 animate-spin" /> : <Crosshair className="size-3" />}
          My location
        </button>
      </div>

      <p className="mt-1.5 text-2xs text-muted-foreground">
        {picked
          ? `Pin: ${lat.toFixed(5)}, ${lon.toFixed(5)} — click the map to adjust.`
          : "Click the map to drop a pin, or use your location."}
      </p>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Place name (optional)"
        maxLength={200}
        className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Address (optional)"
        maxLength={500}
        className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />

      {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}

      <button
        type="button"
        onClick={send}
        disabled={!picked || busy}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MapPin className="size-3.5" />}
        Send location
      </button>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded bg-background/90 text-foreground shadow transition hover:bg-background"
    >
      {children}
    </button>
  );
}
