import * as React from "react";

// A small path router: the server answers every non-API path with the app,
// so each screen has its own address and survives a reload.

const subscribe = (onChange: () => void) => {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
};

export function usePath(): string {
  return React.useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** Goes to a path within the app; a path may end in "#anchor". */
export function navigate(path: string): void {
  const { pathname, hash } = window.location;
  if (path === pathname + hash) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** A plain left click, which the app follows itself; others open a new tab or window as usual. */
export function isPlainClick(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return !(event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/** Follows a plain left click on a link without reloading the page. */
export function followLink(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  navigate(event.currentTarget.pathname + event.currentTarget.hash);
}
