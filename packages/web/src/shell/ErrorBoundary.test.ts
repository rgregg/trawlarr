import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ErrorBoundary } from './ErrorBoundary.js';

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    const html = renderToString(
      createElement(ErrorBoundary, null, createElement('div', null, 'hello world')),
    );
    expect(html).toContain('hello world');
  });

  it('updates state via getDerivedStateFromError when an error occurs', () => {
    const error = new Error('kaboom');
    const nextState = ErrorBoundary.getDerivedStateFromError(error);
    expect(nextState).toEqual({ hasError: true, error });
  });
});
