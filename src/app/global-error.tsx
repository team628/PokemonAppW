'use client';

/** Last resort: the root layout itself failed, so this renders its own document. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          background: '#0B0E14',
          color: '#E8ECF4',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          display: 'flex',
          minHeight: '100dvh',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
          textAlign: 'center',
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700 }}>SetValue could not start</h1>
          <p style={{ marginTop: '.5rem', fontSize: '.875rem', color: '#8A94A6' }}>
            Your collection data is untouched.
            {error.digest ? ` Reference: ${error.digest}` : ''}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              borderRadius: '.75rem',
              background: '#fff',
              color: '#0B0E14',
              padding: '.75rem 1.25rem',
              fontWeight: 600,
              border: 0,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
