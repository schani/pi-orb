export function signIn(): void {
  const { pathname, search, hash } = window.location;
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(pathname + search + hash)}`);
}
