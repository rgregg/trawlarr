import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrandMark } from './BrandMark.js';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

/**
 * Catches unhandled React render and lifecycle errors anywhere in the tree.
 *
 * Without an Error Boundary, React 18 completely unmounts the entire DOM tree
 * upon encountering any render error, rendering the screen completely blank
 * with no indication to the operator of what went wrong.
 *
 * This renders an accessible, in-place failure dialog with the error message,
 * stack trace, a reload button, a cache-reset action, and a button to copy
 * the error details for reporting.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ componentStack: errorInfo.componentStack ?? null });
    console.error('Unhandled UI exception caught by ErrorBoundary:', error, errorInfo);
  }

  private handleReload = (): void => {
    const loc = (globalThis as { location?: { reload?: () => void } }).location;
    loc?.reload?.();
  };

  private handleReset = (): void => {
    try {
      (globalThis as { localStorage?: Storage }).localStorage?.clear?.();
      (globalThis as { sessionStorage?: Storage }).sessionStorage?.clear?.();
    } catch {
      // Storage access may be restricted
    }
    const loc = (globalThis as { location?: { href?: string } }).location;
    if (loc !== undefined) {
      loc.href = '/';
    }
  };

  private handleCopy = async (): Promise<void> => {
    const message = this.state.error?.message ?? 'Unknown error';
    const stack = this.state.error?.stack ?? '';
    const componentStack = this.state.componentStack ?? '';
    const text = `Trawlarr Web Error:\n${message}\n\nStack:\n${stack}\n\nComponent Stack:\n${componentStack}`;
    try {
      const nav = (
        globalThis as {
          navigator?: { clipboard?: { writeText?: (s: string) => Promise<void> } };
        }
      ).navigator;
      await nav?.clipboard?.writeText?.(text);
    } catch {
      // Clipboard write not permitted
    }
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { error, componentStack } = this.state;
    const title = this.props.fallbackTitle ?? 'Something went wrong';

    return (
      <div className="auth-gate" style={{ maxWidth: '42rem', margin: '8vh auto' }}>
        <span className="app-brand">
          <BrandMark />
        </span>
        <h1 style={{ color: 'var(--bad, #e05252)' }}>{title}</h1>
        <p>An unexpected error occurred while rendering the view.</p>

        {error !== null && (
          <div role="alert" className="failure" style={{ marginTop: '1rem' }}>
            <strong>
              {error.name}: {error.message}
            </strong>
            {error.stack !== undefined && (
              <pre
                className="verbatim"
                style={{
                  maxHeight: '14rem',
                  overflowY: 'auto',
                  fontSize: '0.75rem',
                  marginTop: '0.5rem',
                }}
              >
                {error.stack}
              </pre>
            )}
          </div>
        )}

        {componentStack !== null && componentStack.trim() !== '' && (
          <details style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--ink-muted)' }}>
              Component stack
            </summary>
            <pre
              className="verbatim"
              style={{
                maxHeight: '10rem',
                overflowY: 'auto',
                fontSize: '0.75rem',
                marginTop: '0.4rem',
              }}
            >
              {componentStack}
            </pre>
          </details>
        )}

        <div
          className="row-actions"
          style={{ marginTop: '1.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}
        >
          <button type="button" className="btn-primary" onClick={this.handleReload}>
            Reload page
          </button>
          <button type="button" onClick={() => void this.handleCopy()}>
            Copy error details
          </button>
          <button type="button" onClick={this.handleReset}>
            Reset cache &amp; return to home
          </button>
        </div>
      </div>
    );
  }
}
