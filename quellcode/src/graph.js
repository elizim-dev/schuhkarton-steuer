// Anmeldung (Microsoft) und Zugriff auf OneDrive über Microsoft Graph
import { PublicClientApplication, InteractionRequiredAuthError } from "@azure/msal-browser";
import { CLIENT_ID, REDIRECT_URI, SCOPES, GRAPH } from "./config.js";

let msal = null;
let account = null;

export async function initAuth() {
  msal = new PublicClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: "https://login.microsoftonline.com/common",
      redirectUri: REDIRECT_URI,
      postLogoutRedirectUri: REDIRECT_URI,
    },
    cache: { cacheLocation: "localStorage" },
  });
  await msal.initialize();
  const res = await msal.handleRedirectPromise();
  if (res && res.account) account = res.account;
  if (!account) account = msal.getActiveAccount() || msal.getAllAccounts()[0] || null;
  if (account) msal.setActiveAccount(account);
  return account;
}

export function getAccount() {
  return account;
}

export function login() {
  return msal.loginRedirect({ scopes: SCOPES, prompt: "select_account" });
}

export function logout() {
  return msal.logoutRedirect({ account });
}

async function token() {
  if (!account) throw new Error("Nicht angemeldet");
  try {
    const r = await msal.acquireTokenSilent({ scopes: SCOPES, account });
    return r.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      await msal.acquireTokenRedirect({ scopes: SCOPES, account });
      throw new Error("Anmeldung wird erneuert …");
    }
    throw e;
  }
}

export class GraphError extends Error {
  constructor(status, body) {
    let msg = `OneDrive-Fehler ${status}`;
    try {
      const j = JSON.parse(body);
      if (j.error && j.error.message) msg += `: ${j.error.message}`;
    } catch (_) {}
    super(msg);
    this.status = status;
    this.body = body;
  }
}

export async function g(path, opts = {}) {
  const t = await token();
  const url = path.startsWith("http") ? path : GRAPH + path;
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: "Bearer " + t, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new GraphError(res.status, await res.text());
  return res;
}

export async function gj(path, opts = {}) {
  const res = await g(path, opts);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --- Pfade ------------------------------------------------------------------

const enc = (rel) => rel.split("/").map(encodeURIComponent).join("/");
export const itemPath = (driveId, itemId) => `/drives/${driveId}/items/${itemId}`;

export async function myDrive() {
  return gj("/me/drive?$select=id,driveType,owner");
}

export async function getItem(driveId, itemId) {
  return gj(`${itemPath(driveId, itemId)}?$select=id,name,folder,parentReference,webUrl,remoteItem`);
}

// Kind über relativen Pfad; null, wenn nicht vorhanden
export async function childByPath(driveId, parentId, rel) {
  try {
    return await gj(`${itemPath(driveId, parentId)}:/${enc(rel)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function listFolders(driveId, itemId) {
  const base = itemId ? `${itemPath(driveId, itemId)}/children` : `/drives/${driveId}/root/children`;
  let url = `${base}?$top=200&$select=id,name,folder,remoteItem,parentReference`;
  const out = [];
  while (url) {
    const j = await gj(url);
    for (const it of j.value || []) {
      if (it.folder) out.push({ name: it.name, driveId, id: it.id });
      else if (it.remoteItem && it.remoteItem.folder) {
        out.push({
          name: it.name,
          driveId: it.remoteItem.parentReference.driveId,
          id: it.remoteItem.id,
          geteilt: true,
        });
      }
    }
    url = j["@odata.nextLink"] || null;
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "de"));
  return out;
}

export async function ensureFolder(driveId, parentId, name) {
  const existing = await childByPath(driveId, parentId, name);
  if (existing) return existing;
  try {
    return await gj(`${itemPath(driveId, parentId)}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
  } catch (e) {
    if (e.status === 409) return childByPath(driveId, parentId, name);
    throw e;
  }
}

export async function ensurePath(driveId, parentId, segments) {
  let cur = parentId;
  for (const s of segments) cur = (await ensureFolder(driveId, cur, s)).id;
  return cur;
}

// Freigabelink → Ordner
export async function resolveShareLink(url) {
  const b64 = btoa(unescape(encodeURIComponent(url.trim())))
    .replace(/=+$/, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
  const it = await gj(`/shares/u!${b64}/driveItem?$select=id,name,folder,parentReference,remoteItem`, {
    headers: { Prefer: "redeemSharingLinkIfNecessary" },
  });
  if (!it.folder) throw new Error("Der Link zeigt nicht auf einen Ordner.");
  return { name: it.name, driveId: it.parentReference.driveId, id: it.id };
}

// --- JSON-Dateien mit Versionsschutz (eTag) -----------------------------------

export async function readJson(driveId, parentId, name) {
  const meta = await childByPath(driveId, parentId, name);
  if (!meta) return { data: null, etag: null };
  const dl = meta["@microsoft.graph.downloadUrl"];
  const res = dl ? await fetch(dl, { cache: "no-store" }) : await g(`${itemPath(driveId, meta.id)}/content`);
  if (!res.ok) throw new Error("Datei konnte nicht gelesen werden: " + name);
  return { data: await res.json(), etag: meta.eTag };
}

export async function writeJson(driveId, parentId, name, data, etag) {
  const headers = { "Content-Type": "application/json" };
  if (etag) headers["If-Match"] = etag;
  return gj(`${itemPath(driveId, parentId)}:/${enc(name)}:/content`, {
    method: "PUT",
    headers,
    body: JSON.stringify(data, null, 1),
  });
}

// --- Datei-Upload -------------------------------------------------------------

export async function uploadFile(driveId, parentId, name, blob, { overwrite = false } = {}) {
  const cb = overwrite ? "replace" : "rename";
  if (blob.size <= 4 * 1024 * 1024) {
    return gj(`${itemPath(driveId, parentId)}:/${enc(name)}:/content?@microsoft.graph.conflictBehavior=${cb}`, {
      method: "PUT",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    });
  }
  const session = await gj(`${itemPath(driveId, parentId)}:/${enc(name)}:/createUploadSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": cb } }),
  });
  const CHUNK = 327680 * 10;
  let start = 0;
  let last = null;
  while (start < blob.size) {
    const end = Math.min(start + CHUNK, blob.size);
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes ${start}-${end - 1}/${blob.size}` },
      body: blob.slice(start, end),
    });
    if (!res.ok) throw new GraphError(res.status, await res.text());
    last = res.status === 202 ? null : await res.json();
    start = end;
  }
  return last;
}

// --- Freigaben (Personen freischalten) ---------------------------------------

export async function invite(driveId, itemId, email, nachricht) {
  return gj(`${itemPath(driveId, itemId)}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipients: [{ email }],
      requireSignIn: true,
      sendInvitation: true,
      roles: ["write"],
      message: nachricht,
    }),
  });
}

export async function listPermissions(driveId, itemId) {
  const j = await gj(`${itemPath(driveId, itemId)}/permissions`);
  return j.value || [];
}

export async function deletePermission(driveId, itemId, permId) {
  return gj(`${itemPath(driveId, itemId)}/permissions/${permId}`, { method: "DELETE" });
}

// --- Persönlicher App-Ordner (Verbindungen geräteübergreifend merken) ---------

let approot = null;
export async function appRoot() {
  if (!approot) {
    const it = await gj("/me/drive/special/approot?$select=id,parentReference");
    approot = { driveId: it.parentReference.driveId, id: it.id };
  }
  return approot;
}

export async function renameItem(driveId, itemId, name) {
  return gj(`${itemPath(driveId, itemId)}?@microsoft.graph.conflictBehavior=rename`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}
