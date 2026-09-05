interface NotFoundPageProps {
  resourceName?: string;
}

export function NotFoundPage({ resourceName }: NotFoundPageProps) {
  const subject = resourceName === undefined ? "Page" : resourceName;

  return (
    <main className="page simple-page">
      <h1>{subject} doesn't exist</h1>
      <a href="#/">Back to dashboard</a>
    </main>
  );
}
