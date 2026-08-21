/**
 * Vite turns a CSS import into a side effect that injects the stylesheet;
 * `tsc` has no idea what a `.css` module is. This says "it exists and exports
 * nothing", so `tsconfig.app.json`'s typecheck pass does not fail on the one
 * import that makes the app look like anything.
 */
declare module '*.css';
