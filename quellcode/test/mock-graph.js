// Test-Ersatz für graph.js: simuliertes OneDrive im Speicher
const gespeichert = JSON.parse(localStorage.getItem("mock_drive") || "null");
let n = gespeichert ? gespeichert.n : 0;
const nid = () => "id" + ++n;
const items = gespeichert ? gespeichert.items : {};
const save = () => localStorage.setItem("mock_drive", JSON.stringify({ n, items, perms: window.__perms || {} }));
setInterval(save, 200);
const DRIVE = "drive-eli";
const ROOT = "root";
if (!gespeichert) items[ROOT] = { id: ROOT, name: "root", folder: true, parent: null, driveId: DRIVE };
function mk(name, parent, extra = {}) {
  const id = nid();
  items[id] = { id, name, parent, driveId: DRIVE, eTag: '"1"', ...extra };
  return items[id];
}
let steuer;
if (!gespeichert) {
  steuer = mk("Steuer", ROOT, { folder: true });
  const sk = mk("Schuhkarton_Steuer", steuer.id, { folder: true });
  mk("Privat", sk.id, { folder: true });
  mk("regulationwiseGbR", sk.id, { folder: true });
  mk("Dokumente", ROOT, { folder: true });
} else steuer = Object.values(items).find((x) => x.name === "Steuer");
window.__drive = items;

export class GraphError extends Error {
  constructor(status, body) { super("OneDrive-Fehler " + status); this.status = status; this.body = body; }
}
let account = null;
export async function initAuth() { const u = localStorage.getItem("mock_user") || "eli@example.com"; account = { name: u.split("@")[0], username: u }; return account; }
export function getAccount() { return account; }
export async function login() {}
export async function logout() {}
export const itemPath = (d, i) => `/drives/${d}/items/${i}`;
export async function myDrive() { return { id: account.username === "eli@example.com" ? DRIVE : "drive-" + account.username }; }
const kids = (pid) => Object.values(items).filter((x) => x.parent === pid);
export async function getItem(d, id) { return items[id]; }
export async function childByPath(d, pid, rel) {
  let cur = pid;
  for (const seg of rel.split("/")) {
    const k = kids(cur).find((x) => x.name === seg);
    if (!k) return null;
    cur = k.id;
  }
  const it = items[cur];
  return { ...it, "@microsoft.graph.downloadUrl": it.folder ? undefined : "mock://" + it.id };
}
export async function listFolders(d, id) {
  return kids(id || ROOT).filter((x) => x.folder).map((x) => ({ name: x.name, driveId: d, id: x.id })).sort((a, b) => a.name.localeCompare(b.name));
}
export async function ensureFolder(d, pid, name) { return (await childByPath(d, pid, name)) || mk(name, pid, { folder: true }); }
export async function ensurePath(d, pid, segs) { let c = pid; for (const s of segs) c = (await ensureFolder(d, c, s)).id; return c; }
export async function resolveShareLink(url) { if (url.includes("invite")) { const g = Object.values(items).find((x) => x.name === "regulationwiseGbR"); return { name: g.name, driveId: DRIVE, id: g.id }; } return { name: "Steuer", driveId: DRIVE, id: steuer.id }; }
export async function readJson(d, pid, name) {
  const m = await childByPath(d, pid, name);
  if (!m) return { data: null, etag: null };
  return { data: JSON.parse(items[m.id].text), etag: items[m.id].eTag };
}
export async function writeJson(d, pid, name, data, etag) {
  const m = await childByPath(d, pid, name);
  if (m && etag && m.eTag !== etag) throw new GraphError(412, "");
  const it = m ? items[m.id] : mk(name, pid);
  it.text = JSON.stringify(data);
  it.eTag = '"' + (parseInt(String(it.eTag).replace(/"/g, "")) + 1) + '"';
  return { id: it.id, eTag: it.eTag };
}
export async function uploadFile(d, pid, name, blob, { overwrite = false } = {}) {
  let nm = name;
  const ex = await childByPath(d, pid, nm);
  if (ex && overwrite) { items[ex.id].size = blob.size; return items[ex.id]; }
  let i = 1;
  while (await childByPath(d, pid, nm)) nm = name.replace(/\.pdf$/, ` ${i++}.pdf`);
  const it = mk(nm, pid, { size: blob.size, webUrl: "https://onedrive.example/" + encodeURIComponent(nm) });
  window.__uploads = (window.__uploads || []).concat([{ name: nm, size: blob.size, type: blob.type }]);
  return it;
}
export async function renameItem(d, id, name) { items[id].name = name; items[id].webUrl = "https://onedrive.example/" + encodeURIComponent(name); return items[id]; }
export async function g() { throw new Error("nicht im Test"); }
export async function gj() { throw new Error("nicht im Test"); }

const perms = (window.__perms = gespeichert ? gespeichert.perms : {});
export async function invite(d, id, email) { (perms[id] = perms[id] || []).push({ id: "p" + email, roles: ["write"], invitation: { email } }); return { value: [{ link: { webUrl: "https://1drv.ms/f/s!invite" } }] }; }
export async function listPermissions(d, id) { return [{ id: "own", roles: ["owner"], grantedToV2: { user: { displayName: "Elizabeth" } } }, ...(perms[id] || [])]; }
export async function deletePermission(d, id, pid) { perms[id] = (perms[id] || []).filter((p) => p.id !== pid); }
export async function appRoot() { const u = account.username; let r = Object.values(items).find((x) => x.name === "approot-" + u); if (!r) r = mk("approot-" + u, ROOT, { folder: true }); return { driveId: DRIVE, id: r.id }; }
