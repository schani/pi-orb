interface NotFoundPageProps {
  resourceName?: string;
}

export function NotFoundPage({ resourceName }: NotFoundPageProps) {
  const subject = resourceName === undefined ? "Page" : resourceName;

  return (
    <>
      <header className="app-header">
        <a href="#/" className="app-title">
          pi-orb
        </a>
      </header>
      <main className="app-main page not-found-page">
        <h1>{subject} doesn't exist</h1>
        <p>The {subject.toLowerCase()} may have been deleted, or the URL may be incorrect.</p>
        <a href="#/">Go to dashboard</a>
      </main>
    </>
  );
}
