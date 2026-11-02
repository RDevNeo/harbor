/** browser.rs `web`: an http(s) URL, the only kind "Open in my browser" hands to the system. */
export function web(url: string): boolean {
  const u = url.toLowerCase();
  return u.startsWith("http://") || u.startsWith("https://");
}
