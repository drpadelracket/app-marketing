// Login por PIN e sessão assinada (sem base de dados de utilizadores)
import crypto from "node:crypto";
import { HttpError } from "./notion.mjs";

// USERS no Netlify, ex.: {"4821":{"nome":"Fábio","papel":"ads"},"7390":{"nome":"Designer","papel":"design"},"1111":{"nome":"Leonardo","papel":"admin"}}
export function users() {
  try {
    return JSON.parse(process.env.USERS || "{}");
  } catch {
    throw new HttpError(500, "A variável USERS não é JSON válido");
  }
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new HttpError(500, "Falta SESSION_SECRET (mínimo 16 caracteres) no Netlify");
  return s;
}

const b64 = (s) => Buffer.from(s).toString("base64url");
export const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

// SEM_PIN=1 no Netlify: entra-se só a escolher o nome (sem PIN)
export const semPin = () => process.env.SEM_PIN === "1";
export const nomes = () => Object.values(users()).map((u) => u.nome);

export function login(pin, nome) {
  const u = semPin() && nome
    ? Object.values(users()).find((x) => x.nome === nome)
    : users()[String(pin || "").trim()];
  if (!u) throw new HttpError(401, semPin() ? "Utilizador desconhecido" : "PIN errado");
  const papel = ["ads", "design", "admin"].includes(u.papel) ? u.papel : "ads";
  const user = { nome: u.nome || "Utilizador", papel };
  const payload = b64(JSON.stringify({ ...user, exp: Date.now() + 30 * 864e5 }));
  return { token: `${payload}.${sign(payload)}`, user };
}

export function verify(req) {
  const h = req.headers.get("authorization") || "";
  const tok = h.replace(/^Bearer\s+/i, "");
  const [payload, sig] = tok.split(".");
  if (!payload || !sig) throw new HttpError(401, "Sessão em falta");
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new HttpError(401, "Sessão inválida");
  }
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (data.exp < Date.now()) throw new HttpError(401, "Sessão expirada");
  // se o PIN foi removido do USERS, a sessão deixa de valer
  const still = Object.values(users()).some((u) => u.nome === data.nome);
  if (!still) throw new HttpError(401, "Utilizador removido");
  return { nome: data.nome, papel: data.papel };
}
