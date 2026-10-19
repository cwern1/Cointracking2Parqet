export class MemoryStorage {
    map = new Map();
    get length() {
        return this.map.size;
    }
    clear() {
        this.map.clear();
    }
    getItem(k) {
        return this.map.get(k) ?? null;
    }
    key(i) {
        return [...this.map.keys()][i] ?? null;
    }
    removeItem(k) {
        this.map.delete(k);
    }
    setItem(k, v) {
        this.map.set(k, String(v));
    }
}
