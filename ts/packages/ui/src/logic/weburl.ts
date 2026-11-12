/** An http(s) URL: the only kind (with mailto:) Harbor hands to the system's browser. */
export function web(url: string): boolean {
  const u = url.toLowerCase();
  return u.startsWith("http://") || u.startsWith("https://");
}

