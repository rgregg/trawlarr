import type { ReactNode } from 'react';

/**
 * The one `<h1>` on a screen.
 *
 * Before this existed no screen had an h1 at all — each opened on an `<h2>`
 * used as a title, so the heading outline of every page started at level 2
 * and the sections under it were siblings of the page name rather than
 * children of it. The shell renders this for the four top-level screens; a
 * detail screen renders its own, because only it knows what the thing is
 * called.
 */
export const PageHeader = (props: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): JSX.Element => (
  <div className="page-header">
    <h1>{props.title}</h1>
    {props.subtitle !== undefined && <p className="page-subtitle">{props.subtitle}</p>}
    {props.actions !== undefined && <div className="page-actions">{props.actions}</div>}
  </div>
);
