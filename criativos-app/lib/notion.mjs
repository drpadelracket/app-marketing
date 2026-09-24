// Ligação à API do Notion (usada pelas functions; o token nunca chega ao browser)
const API = process.env.NOTION_API_BASE || "https://api.notion.com";
const VERSION = "2026-03-11";

export const DATA_SOURCE_ID =
  process.env.NOTION_DATA_SOURCE_ID || "3d8320d4-8712-8069-8358-000b7c995ad5";

export const ESTADOS = ["Pedido", "Em design", "Revisão", "Alterações", "Aprovado", "Publicado"];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new HttpError(500, "Falta a variável NOTION_TOKEN no Netlify");
  return t;
}

// Pedido genérico à API, com 1 nova tentativa se o Notion pedir para abrandar (429)
export async function notion(path, { method = "GET", body, form } = {}, attempt = 0) {
  const headers = { Authorization: `Bearer ${token()}`, "Notion-Version": VERSION };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(API + path, { method, headers, body: payload });
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get("retry-after") || 1) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return notion(path, { method, body, form }, attempt + 1);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    throw new HttpError(res.status >= 500 ? 502 : 400, `Notion: ${data.message || res.status}`);
  }
  return data;
}

// ---------- conversão página Notion -> ticket simples ----------
const plain = (arr) => (arr || []).map((t) => t.plain_text ?? t.text?.content ?? "").join("");

function files(prop) {
  return (prop?.files || []).map((f) => ({
    name: f.name,
    type: f.type,
    url: f.type === "external" ? f.external?.url : f.file?.url,
  }));
}

export function toTicket(page) {
  const p = page.properties || {};
  const uid = p.ID?.unique_id;
  return {
    id: page.id,
    url: page.url,
    num: uid ? `${uid.prefix ? uid.prefix + "-" : ""}${uid.number}` : "",
    nome: plain(p.Nome?.title),
    estado: p.Estado?.select?.name || "Pedido",
    prioridade: p.Prioridade?.select?.name || "Normal",
    prazo: p.Prazo?.date?.start || null,
    tipo: p.Tipo?.select?.name || "",
    formato: (p.Formato?.multi_select || []).map((o) => o.name),
    mercado: p.Mercado?.select?.name || "",
    objetivo: p.Objetivo?.select?.name || "",
    campanha: plain(p.Campanha?.rich_text),
    brief: plain(p.Brief?.rich_text),
    copy: plain(p.Copy?.rich_text),
    referencias: plain(p["Referências"]?.rich_text),
    refFiles: files(p["Ficheiros referência"]),
    criativos: files(p.Criativos),
    linkDrive: p["Link Drive"]?.url || "",
    versao: p["Versão"]?.number || 0,
    pedidoPor: plain(p["Pedido por"]?.rich_text),
    designer: plain(p.Designer?.rich_text),
    criado: page.created_time,
    editado: page.last_edited_time,
  };
}

// ---------- ticket simples -> propriedades Notion ----------
function rt(text) {
  const s = String(text ?? "");
  const out = [];
  for (let i = 0; i < s.length && out.length < 100; i += 2000) {
    out.push({ type: "text", text: { content: s.slice(i, i + 2000) } });
  }
  return out;
}
const sel = (v) => (v ? { select: { name: String(v).replace(/,/g, " ") } } : { select: null });

const MAP = {
  nome: (v) => ["Nome", { title: rt(v) }],
  estado: (v) => ["Estado", sel(v)],
  prioridade: (v) => ["Prioridade", sel(v)],
  prazo: (v) => ["Prazo", { date: v ? { start: v } : null }],
  tipo: (v) => ["Tipo", sel(v)],
  formato: (v) => ["Formato", { multi_select: (v || []).map((name) => ({ name })) }],
  mercado: (v) => ["Mercado", sel(v)],
  objetivo: (v) => ["Objetivo", sel(v)],
  campanha: (v) => ["Campanha", { rich_text: rt(v) }],
  brief: (v) => ["Brief", { rich_text: rt(v) }],
  copy: (v) => ["Copy", { rich_text: rt(v) }],
  referencias: (v) => ["Referências", { rich_text: rt(v) }],
  linkDrive: (v) => ["Link Drive", { url: v || null }],
  versao: (v) => ["Versão", { number: Number(v) || 0 }],
  pedidoPor: (v) => ["Pedido por", { rich_text: rt(v) }],
  designer: (v) => ["Designer", { rich_text: rt(v) }],
};

export function toProps(fields) {
  const props = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!MAP[k]) continue;
    const [name, value] = MAP[k](v);
    props[name] = value;
  }
  return props;
}

export const FILE_PROPS = { criativos: "Criativos", refFiles: "Ficheiros referência" };

// Converte ficheiros já existentes para o formato de escrita (para os manter ao acrescentar)
export function keepFiles(prop) {
  return (prop?.files || []).map((f) =>
    f.type === "external"
      ? { name: f.name, type: "external", external: { url: f.external.url } }
      : { name: f.name, type: "file", file: { url: f.file.url } }
  );
}

// ---------- operações ----------
export async function listTickets() {
  const since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const body = {
    page_size: 100,
    filter: {
      or: [
        { property: "Estado", select: { does_not_equal: "Publicado" } },
        { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
  };
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const data = await notion(`/v1/data_sources/${DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: cursor ? { ...body, start_cursor: cursor } : body,
    });
    for (const pg of data.results || []) if (!pg.in_trash) out.push(toTicket(pg));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

export async function getPage(id) {
  return notion(`/v1/pages/${id}`);
}

export async function assertInDataSource(page) {
  const ds = page.parent?.data_source_id;
  if (ds && ds.replace(/-/g, "") !== DATA_SOURCE_ID.replace(/-/g, "")) {
    throw new HttpError(403, "Esta página não pertence à tabela CRIATIVOS ANUNCIOS");
  }
}

export async function createTicket(fields) {
  const page = await notion("/v1/pages", {
    method: "POST",
    body: { parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID }, properties: toProps(fields) },
  });
  return toTicket(page);
}

export async function updateTicket(id, fields, extraProps = {}) {
  const page = await notion(`/v1/pages/${id}`, {
    method: "PATCH",
    body: { properties: { ...toProps(fields), ...extraProps } },
  });
  return toTicket(page);
}

export async function listComments(id) {
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ block_id: id, page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const data = await notion(`/v1/comments?${q}`);
    for (const c of data.results || []) {
      out.push({
        id: c.id,
        autor: c.display_name?.resolved_name || "Notion",
        texto: plain(c.rich_text),
        data: c.created_time,
      });
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

export async function addComment(id, texto, autor) {
  const c = await notion("/v1/comments", {
    method: "POST",
    body: {
      parent: { page_id: id },
      rich_text: rt(texto),
      display_name: { type: "custom", custom: { name: autor } },
    },
  });
  return { id: c.id, autor, texto, data: c.created_time };
}
