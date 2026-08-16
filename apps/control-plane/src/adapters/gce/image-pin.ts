/**
 * True when a container image reference is pinned to an immutable digest.
 * The GCE composition refuses to boot without this: the spec fingerprint
 * hashes the image string, so a moving tag would change host contents
 * without changing the fingerprint and silently defeat immutable
 * replacement (docs/compute-replacement.md).
 */
export function isDigestPinnedImage(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/i.test(image);
}
