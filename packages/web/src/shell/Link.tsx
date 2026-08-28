import type { ReactNode } from 'react';

/**
 * A real `<a href>` that pushes instead of reloading.
 *
 * It stays an anchor so middle-click, ctrl-click and "copy link address" all
 * behave — a button styled as a link silently loses those, and this UI's whole
 * point is that things are linkable.
 */
export const Link = (props: {
  to: string;
  children: ReactNode;
  className?: string;
  navigate: (to: string) => void;
  'aria-current'?: 'page' | undefined;
}): JSX.Element => (
  <a
    href={props.to}
    className={props.className}
    aria-current={props['aria-current']}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      props.navigate(props.to);
    }}
  >
    {props.children}
  </a>
);
