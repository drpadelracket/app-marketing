// Armazenamento temporário dos pedaços de ficheiro enquanto sobem para o Notion
import { getStore } from "@netlify/blobs";

const mem = (globalThis.__memStore ||= new Map());
const memStore = {
  async set(k, v) {
    mem.set(k, v instanceof ArrayBuffer ? v.slice(0) : v);
  },
  async setJSON(k, v) {
    mem.set(k, JSON.stringify(v));
  },
  async get(k, opts = {}) {
    if (!mem.has(k)) return null;
    const v = mem.get(k);
    if (opts.type === "json") return JSON.parse(v);
    if (opts.type === "arrayBuffer") return v;
    return v;
  },
  async delete(k) {
    mem.delete(k);
  },
};

export function uploads() {
  if (process.env.LOCAL_BLOBS === "1") return memStore; // só para testes locais
  return getStore({ name: "uploads-criativos", consistency: "strong" });
}
