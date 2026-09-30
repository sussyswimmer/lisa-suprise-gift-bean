// Node 25 and later define their own global localStorage, which stays
// undefined unless Node starts with --localstorage-file. It hides the jsdom
// storage the tests rely on, so give each test file an in-memory one instead.
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

function usable(storage: unknown): storage is Storage {
  return (
    typeof storage === "object" &&
    storage !== null &&
    typeof (storage as Storage).clear === "function"
  );
}

if (typeof window !== "undefined") {
  let current: unknown;
  try {
    current = globalThis.localStorage;
  } catch {
    current = undefined;
  }
  if (!usable(current)) {
    const storage = new MemoryStorage();
    for (const target of new Set<object>([globalThis, window])) {
      Object.defineProperty(target, "localStorage", {
        configurable: true,
        value: storage,
      });
    }
  }
}
