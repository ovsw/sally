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

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Follows a plain left click on a link without reloading the page. */
export function followLink(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  navigate(event.currentTarget.pathname);
}
