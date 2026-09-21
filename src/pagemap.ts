import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./chrome.ts";

const FILE = join(HOME, "pagemap.json");

export interface Landmark {
  role: string;
  name: string;
}

type Store = Record<string, Record<string, Landmark>>;

const load = (): Store => {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
};

/** Origin plus path with ids collapsed, so /orders/123 and /orders/456 share one entry. */
export function routeKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27}$|^[0-9a-f]{16,}$/i.test(seg) ? ":id" : seg))
      .join("/");
    return u.origin + path;
  } catch {
    return url;
  }
}

export function lookup(url: string, description: string): Landmark | undefined {
  return load()[routeKey(url)]?.[description];
}

export function remember(url: string, description: string, landmark: Landmark): void {
  const store = load();
  (store[routeKey(url)] ??= {})[description] = landmark;
  mkdirSync(HOME, { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 1));
}

export function forget(url: string, description: string): void {
  const store = load();
  delete store[routeKey(url)]?.[description];
  writeFileSync(FILE, JSON.stringify(store, null, 1));
}

export function clearPagemap(): void {
  rmSync(FILE, { force: true });
}
