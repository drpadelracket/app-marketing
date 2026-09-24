// Função de fundo (até 15 min): envia o ficheiro montado para o Notion
import crypto from "node:crypto";
import { sign } from "../../lib/auth.mjs";
import { processUpload } from "../../lib/upload.mjs";

export default async (req) => {
  let key;
  try {
    ({ key } = await req.json());
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const sig = req.headers.get("x-sig") || "";
  const expected = sign(`upload:${key}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return new Response("forbidden", { status: 403 });
  }
  await processUpload(key);
  return new Response("ok");
};
