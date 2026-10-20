export default function HomePage() {
  return (
    <div className="foundation mx-auto flex min-h-svh w-full max-w-6xl flex-col">
      <a className="skip-link" href="#main-content">Skip to content</a>

      <header className="masthead flex flex-wrap items-center justify-between gap-4">
        <span className="wordmark">Habi</span>
        <span className="preview-label">Foundation preview</span>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1">
        <section className="introduction grid items-center" aria-labelledby="page-title">
          <div>
            <h1 id="page-title">Weave ideas into action.</h1>
            <p className="introduction-note">Every idea needs a starting point.<br />This is ours.</p>
          </div>

          <svg className="weave" viewBox="0 0 280 280" fill="none" aria-hidden="true" focusable="false">
            <g stroke="var(--thread-muted)" strokeWidth="1">
              <path d="M56 12V268M98 12V268M140 12V268M182 12V268M224 12V268" />
              <path d="M12 56H268M12 98H268M12 140H268M12 182H268M12 224H268" />
            </g>
            <g stroke="var(--ink)" strokeWidth="8" strokeLinecap="round">
              <path d="M98 30V250M140 30V250M182 30V250" />
            </g>
            <g stroke="var(--thread)" strokeWidth="8" strokeLinecap="round">
              <path d="M30 98H250M30 140H250M30 182H250" />
            </g>
            <g stroke="var(--paper)" strokeWidth="14">
              <path d="M98 87V109M182 87V109M140 129V151M98 171V193M182 171V193" />
            </g>
            <g stroke="var(--ink)" strokeWidth="8">
              <path d="M98 85V111M182 85V111M140 127V153M98 169V195M182 169V195" />
            </g>
          </svg>
        </section>

        <section className="scope grid" aria-label="Foundation scope">
          <div className="scope-copy">
            <h2>A foundation, not a finished product.</h2>
            <p>This repository proves the workspace, web shell, API health endpoint, worker boot path, and local PostgreSQL tooling.</p>
          </div>
          <div className="scope-copy scope-boundary">
            <h2>What&apos;s not here</h2>
            <p>It does not include sign-in, chat, Bots, model calls, or Hermes.</p>
            <p className="availability">No product functionality is available yet.</p>
          </div>
        </section>
      </main>

      <footer className="footer flex flex-wrap justify-between gap-3">
        <span>Habi · Repository foundation</span>
        <span>Just the first threads.</span>
      </footer>
    </div>
  );
}
