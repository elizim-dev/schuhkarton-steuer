// Test-Ersatz für graph.js: simuliertes OneDrive im Speicher
let n = 0;
const nid = () => "id" + ++n;
const items = {};
const DRIVE = "drive-eli";
const ROOT = "root";
items[ROOT] = { id: ROOT, name: "root", folder: true, parent: null, driveId: DRIVE };
function mk(name, parent, extra = {}) {
  const id = nid();
  items[id] = { id, name, parent, driveId: DRIVE, eTag: '"1"', ...extra };
  return items[id];
}
const steuer = mk("Steuer", ROOT, { folder: true });
const sk = mk("Schuhkarton_Steuer", steuer.id, { folder: true });
mk("Privat", sk.id, { folder: true });
mk("regulationwiseGbR", sk.id, { folder: true });
mk("Dokumente", ROOT, { folder: true });
window.__drive = items;

export class GraphError extends Error {
  constructor(status, body) { super("OneDrive-Fehler " + status); this.status = status; this.body = body; }
}
let account = null;
export async function initAuth() { account = { name: "Elizabeth Test", username: "eli@example.com" }; return account; }
export function getAccount() { return account; }
export async function login() {}
export async function logout() {}
export const itemPath = (d, i) => `/drives/${d}/items/${i}`;
export async function myDrive() { return { id: DRIVE }; }
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
export async function resolveShareLink(url) { return { name: "Steuer", driveId: DRIVE, id: steuer.id }; }
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
