import mark from '../assets/trawlarr-mark.png';

/**
 * The mark: a trawler with its nets out over the water.
 *
 * A raster rather than inline SVG, so it no longer follows the accent colour;
 * the icon carries its own navy tile, which reads on both themes. Imported
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
