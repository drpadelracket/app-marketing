// API única da app: /api/<ação>
import crypto from "node:crypto";
import {
  HttpError, ESTADOS, FILE_PROPS, listTickets, getPage, toTicket, assertInDataSource,
  createTicket, updateTicket, listComments, addComment, keepFiles,
} from "../../lib/notion.mjs";
import { login, verify, sign, semPin, nomes } from "../../lib/auth.mjs";
import { uploads } from "../../lib/store.mjs";

export const config = { path: "/api/:action" };

const CHUNK = Math.floor(3.5 * 1024 * 1024); // limite de pedido das functions (~4,5 MB binário)
const MAX_FILE = 5 * 1024 * 1024 * 1024; // 5 GB, limite do Notion em plano pago

// Quem pode mudar para que estado
const TRANSICOES = {
  ads: { "Revisão": ["Aprovado", "Alterações"], "Aprovado": ["Publicado", "Alterações"] },
  design: { "Pedido": ["Em design"], "Em design": ["Revisão"], "Alterações": ["Em design", "Revisão"] },
};
const CAMPOS = {
  ads: ["nome", "prioridade", "prazo", "tipo", "formato", "mercado", "objetivo", "campanha", "brief", "copy", "referencias", "linkDrive"],
  design: ["linkDrive", "designer"],
};
const UPLOAD = { ads: ["refFiles"], design: ["criativos"], admin: ["refFiles", "criativos"] };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function body(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function clean(fields, allowed) {
  const out = {};
  for (const k of allowed) if (k in fields) out[k] = fields[k];
  if ("formato" in out && !Array.isArray(out.formato)) out.formato = [];
  if ("prazo" in out && out.prazo && !/^\d{4}-\d{2}-\d{2}/.test(out.prazo)) throw new HttpError(400, "Prazo inválido");
  if ("linkDrive" in out && out.linkDrive && !/^https?:\/\//i.test(out.linkDrive)) throw new HttpError(400, "O link tem de começar por https://");
  return out;
}

async function loadTicketPage(id) {
  if (!/^[0-9a-f-]{32,36}$/i.test(id || "")) throw new HttpError(400, "ID inválido");
  const page = await getPage(id);
  await assertInDataSource(page);
  return page;
}

async function handle(req, action, url) {
  if (action === "config") {
    return json(semPin() ? { semPin: true, nomes: nomes() } : { semPin: false });
  }
  if (action === "login") {
    const { pin, nome } = await body(req);
    return json(login(pin, nome));
  }

  const user = verify(req);
  const papel = user.papel;

  switch (action) {
    case "me":
      return json({ user });

    case "list":
      return json({ tickets: await listTickets() });

    case "get": {
      const id = url.searchParams.get("id");
      const page = await loadTicketPage(id);
      return json({ ticket: toTicket(page), comments: await listComments(id) });
    }

    case "create": {
      if (papel === "design") throw new HttpError(403, "Só o gestor de ads cria pedidos");
      const { fields = {} } = await body(req);
      const f = clean(fields, CAMPOS.ads);
      if (!f.nome?.trim()) throw new HttpError(400, "Dá um nome ao pedido");
      const t = await createTicket({ ...f, estado: "Pedido", pedidoPor: user.nome, versao: 0 });
      return json({ ticket: t });
    }

    case "update": {
      const { id, fields = {}, comment } = await body(req);
      const page = await loadTicketPage(id);
      const atual = toTicket(page);
      const allowed = papel === "admin" ? [...CAMPOS.ads, ...CAMPOS.design] : CAMPOS[papel];
      const f = clean(fields, allowed);

      if (fields.estado && fields.estado !== atual.estado) {
        const novo = fields.estado;
        if (!ESTADOS.includes(novo)) throw new HttpError(400, "Estado inválido");
        const ok = papel === "admin" || (TRANSICOES[papel]?.[atual.estado] || []).includes(novo);
        if (!ok) throw new HttpError(403, `Não podes passar de "${atual.estado}" para "${novo}"`);
        if (novo === "Alterações" && !String(comment || "").trim()) throw new HttpError(400, "Explica o que mudar num comentário");
        f.estado = novo;
        if (novo === "Em design" && !atual.designer) f.designer = user.nome;
        if (novo === "Revisão") {
          if (!atual.criativos.length && !atual.linkDrive) throw new HttpError(400, "Carrega pelo menos um criativo ou um link antes de enviar para revisão");
          f.versao = (atual.versao || 0) + 1;
        }
      }
      if (!Object.keys(f).length && !comment) throw new HttpError(400, "Nada para alterar");
      const t = Object.keys(f).length ? await updateTicket(id, f) : atual;
      let c = null;
      if (String(comment || "").trim()) {
        const prefix = f.estado ? `[${f.estado}${f.estado === "Revisão" ? ` v${f.versao}` : ""}] ` : "";
        c = await addComment(id, prefix + String(comment).trim(), user.nome);
      } else if (f.estado) {
        c = await addComment(id, `[${f.estado}${f.estado === "Revisão" ? ` v${f.versao}` : ""}] estado alterado`, user.nome);
      }
      return json({ ticket: t, comment: c });
    }

    case "comment": {
      const { id, text } = await body(req);
      if (!String(text || "").trim()) throw new HttpError(400, "Comentário vazio");
      await loadTicketPage(id);
      return json({ comment: await addComment(id, String(text).trim(), user.nome) });
    }

    case "remove-file": {
      const { id, prop, index } = await body(req);
      if (!UPLOAD[papel].includes(prop)) throw new HttpError(403, "Sem permissão para este campo");
      const page = await loadTicketPage(id);
      const name = FILE_PROPS[prop];
      const list = keepFiles(page.properties?.[name]);
      if (!(index >= 0 && index < list.length)) throw new HttpError(400, "Ficheiro não encontrado");
      list.splice(index, 1);
      const t = await updateTicket(id, {}, { [name]: { files: list } });
      return json({ ticket: t });
    }

    case "upload-init": {
      const { id, prop, filename, size, type } = await body(req);
      if (!UPLOAD[papel].includes(prop)) throw new HttpError(403, "Sem permissão para carregar neste campo");
      if (!(size > 0 && size <= MAX_FILE)) throw new HttpError(400, "Ficheiro vazio ou maior que 5 GB");
      if (!filename) throw new HttpError(400, "Falta o nome do ficheiro");
      await loadTicketPage(id);
      const key = crypto.randomUUID();
      const chunks = Math.ceil(size / CHUNK);
      await uploads().setJSON(`${key}/meta`, {
        pageId: id, prop: FILE_PROPS[prop], filename: String(filename), size, type: type || "application/octet-stream",
        chunks, status: "receiving", by: user.nome, created: Date.now(),
      });
      return json({ key, chunkSize: CHUNK, chunks });
    }

    case "upload-chunk": {
      const key = url.searchParams.get("key");
      const i = Number(url.searchParams.get("i"));
      const store = uploads();
      const meta = await store.get(`${key}/meta`, { type: "json" });
      if (!meta || meta.status !== "receiving") throw new HttpError(400, "Upload inválido");
      if (!(Number.isInteger(i) && i >= 0 && i < meta.chunks)) throw new HttpError(400, "Pedaço inválido");
      const buf = await req.arrayBuffer();
      const expected = i === meta.chunks - 1 ? meta.size - CHUNK * (meta.chunks - 1) : CHUNK;
      if (buf.byteLength !== expected) throw new HttpError(400, `Pedaço ${i + 1} com tamanho errado`);
      await store.set(`${key}/c/${i}`, buf);
      return json({ ok: true });
    }

    case "upload-finish": {
      const { key } = await body(req);
      const store = uploads();
      const meta = await store.get(`${key}/meta`, { type: "json" });
      if (!meta || meta.status !== "receiving") throw new HttpError(400, "Upload inválido");
      await store.setJSON(`${key}/meta`, { ...meta, status: "queued" });
      const origin = new URL(req.url).origin;
      const res = await fetch(`${origin}/.netlify/functions/process-upload-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sig": sign(`upload:${key}`) },
        body: JSON.stringify({ key }),
      });
      if (!res.ok && res.status !== 202) throw new HttpError(502, "Não foi possível iniciar o envio para o Notion");
      return json({ ok: true });
    }

    case "upload-status": {
      const key = url.searchParams.get("key");
      const meta = await uploads().get(`${key}/meta`, { type: "json" });
      if (!meta) throw new HttpError(404, "Upload não encontrado");
      return json({ status: meta.status, error: meta.error || null });
    }

    default:
      throw new HttpError(404, "Ação desconhecida");
  }
}

export default async (req, context) => {
  const url = new URL(req.url);
  const action = context?.params?.action || url.pathname.split("/").pop();
  try {
    return await handle(req, action, url);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(action, e);
    return json({ error: e.message || "Erro" }, status);
  }
};
