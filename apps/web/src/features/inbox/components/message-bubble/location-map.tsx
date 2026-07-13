import { cn } from "@ccp/shared/utils";

/**
 * A static map preview for a shared location — the real-WhatsApp look: a small
 * map centered on the coordinate with a pin. Dependency-free: it stitches a 3×3
 * grid of raster map tiles (plain <img>, allowed by our `img-src https:` CSP)
 * and translates them so the coordinate sits dead-center, then drops a pin
 * there. No map library, no API key, no external JS.
 *
 * Tiles are CARTO "Voyager" — a clean, light, Google-Maps-like basemap (vs. the
 * busy default OpenStreetMap cartography), served @2x for a crisp retina render.
 * Free + keyless at this app's volume (location messages are infrequent + tiles
 * browser-cache); if tile traffic ever grows, swap TILE_URL for a self-hosted /
 * keyed provider — this component is the single place it's referenced.
 */

const TILE = 256;
const ZOOM = 15; // street level — a few blocks of context, matches WhatsApp
const TILE_URL = (z: number, x: number, y: number) =>
  `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}@2x.png`;

/** Web-Mercator projection → fractional tile coordinate at zoom Z. */
function project(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function LocationMap({
  lat,
  lon,
  className,
}: {
  lat: number;
  lon: number;
  className?: string;
}) {
  // Guard against out-of-range coords — render nothing rather than a broken grid.
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 85 ||
    Math.abs(lon) > 180
  ) {
    return null;
  }

  const n = 2 ** ZOOM;
  const { x, y } = project(lat, lon, ZOOM);
  const xt = Math.floor(x);
  const yt = Math.floor(y);
  // World-pixel position of the coordinate — tiles are offset against this so it
  // lands at the box center (50%/50%).
  const cx = x * TILE;
  const cy = y * TILE;

  const tiles: Array<{ tx: number; ty: number }> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      tiles.push({ tx: xt + dx, ty: yt + dy });
    }
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden bg-muted",
        className,
      )}
      aria-hidden
    >
      {tiles.map(({ tx, ty }) => {
        if (ty < 0 || ty >= n) return null; // no tiles past the poles
        const wx = ((tx % n) + n) % n; // wrap horizontally across the antimeridian
        return (
          // next/image can't drive an absolutely-positioned raster-tile grid.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${tx}_${ty}`}
            src={TILE_URL(ZOOM, wx, ty)}
            alt=""
            width={TILE}
            height={TILE}
            loading="lazy"
            draggable={false}
            className="pointer-events-none absolute max-w-none select-none"
            style={{
              left: `calc(50% + ${tx * TILE - cx}px)`,
              top: `calc(50% + ${ty * TILE - cy}px)`,
            }}
          />
        );
      })}
      {/* Center pin — tip at the exact coordinate (bottom of the teardrop). */}
      <svg
        viewBox="0 0 24 24"
        className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-full drop-shadow"
        fill="#EA4335"
        stroke="#fff"
        strokeWidth="1.5"
      >
        <path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z" />
        <circle cx="12" cy="9" r="2.5" fill="#fff" stroke="none" />
      </svg>
      <span className="absolute bottom-0 right-0 bg-background/70 px-1 text-[8px] leading-tight text-muted-foreground">
        © OpenStreetMap · CARTO
      </span>
    </div>
  );
}
