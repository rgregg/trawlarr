import mark from '../assets/trawlarr-mark.png';

/**
 * The mark: a trawler, bow on, riding the waves.
 *
 * A raster rather than inline SVG, so it does not follow the accent colour.
 * It sits on no tile of its own: the white hull and light water read on both
 * themes, and a tile would put a navy block beside the wordmark. Exported at
 * 192px, twice the largest size it is shown at, so it stays sharp. Imported
 * through Vite so the URL is content-hashed — the daemon serves every asset
 * but `index.html` as immutable for a year, and a fixed filename would pin
 * browsers to the old mark after an upgrade.
 *
 * Empty `alt`: it always sits beside the product name or a heading that says
 * "Trawlarr", so a label here would be read twice.
 */
export const BrandMark = (): JSX.Element => (
  <img className="brand-mark" src={mark} width="24" height="24" alt="" />
);
