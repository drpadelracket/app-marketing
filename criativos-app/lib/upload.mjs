// Junta os pedaços guardados e envia o ficheiro para o Notion (até 5 GB em planos pagos)
import { notion, getPage, keepFiles } from "./notion.mjs";
import { uploads } from "./store.mjs";

const SINGLE_MAX = 20 * 1024 * 1024; // até 20 MB: envio numa só parte
const PART = 10 * 1024 * 1024; // acima: partes de 10 MB (o Notion aceita 5 a 20 MB)

async function sendPart(uploadId, buf, filename, type, partNumber) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type }), filename);
  if (partNumber) form.append("part_number", String(partNumber));
  await notion(`/v1/file_uploads/${uploadId}/send`, { method: "POST", form });
}

export async function processUpload(key) {
  const store = uploads();
  const meta = await store.get(`${key}/meta`, { type: "json" });
  if (!meta) throw new Error("Upload desconhecido");
  const setStatus = (status, extra = {}) => store.setJSON(`${key}/meta`, { ...meta, status, ...extra });

  try {
    await setStatus("processing");
    const type = meta.type || "application/octet-stream";
    const filename = meta.filename.slice(0, 100);
    const readChunk = async (i) => {
      const c = await store.get(`${key}/c/${i}`, { type: "arrayBuffer" });
      if (!c) throw new Error(`Falta o pedaço ${i + 1} de ${meta.chunks}`);
      return Buffer.from(c);
    };

    let fu;
    if (meta.size <= SINGLE_MAX) {
      fu = await notion("/v1/file_uploads", { method: "POST", body: { filename, content_type: type } });
      const parts = [];
      for (let i = 0; i < meta.chunks; i++) parts.push(await readChunk(i));
      await sendPart(fu.id, Buffer.concat(parts), filename, type);
    } else {
      const n = Math.ceil(meta.size / PART);
      fu = await notion("/v1/file_uploads", {
        method: "POST",
        body: { mode: "multi_part", number_of_parts: n, filename, content_type: type },
      });
      let buf = Buffer.alloc(0);
      let part = 1;
      for (let i = 0; i < meta.chunks; i++) {
        buf = Buffer.concat([buf, await readChunk(i)]);
        while (buf.length >= PART && part < n) {
          await sendPart(fu.id, buf.subarray(0, PART), filename, type, part++);
          buf = buf.subarray(PART);
        }
      }
      await sendPart(fu.id, buf, filename, type, part);
      await notion(`/v1/file_uploads/${fu.id}/complete`, { method: "POST", body: {} });
    }

    // acrescenta ao campo de ficheiros sem apagar os que lá estão
    const page = await getPage(meta.pageId);
    const current = keepFiles(page.properties?.[meta.prop]);
    await notion(`/v1/pages/${meta.pageId}`, {
      method: "PATCH",
      body: {
        properties: {
          [meta.prop]: { files: [...current, { type: "file_upload", file_upload: { id: fu.id }, name: filename }] },
        },
      },
    });
    await setStatus("done");
  } catch (e) {
    await setStatus("error", { error: e.message });
  } finally {
    for (let i = 0; i < meta.chunks; i++) await store.delete(`${key}/c/${i}`).catch(() => {});
  }
}
