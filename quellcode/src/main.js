// Schuhkarton Steuer – Oberfläche und Ablauf
import {
  VERSION, CONFIG_FILE, JOURNAL_FILE, BELEGE_FOLDER, KI_MODELLE, KI_STANDARD,
  KATEGORIEN_AUSGABE, KATEGORIEN_EINNAHME, EIGENBELEG_GRUENDE,
  KM_PAUSCHALE_CENT, HOMEOFFICE_TAG_CENT, HOMEOFFICE_MAX_CENT,
} from "./config.js";
import * as G from "./graph.js";
import {
  esc, heute, uuid, euro, betragText, parseBetrag, datumDE, dateiname,
  compressImage, bilderZuPdf, eigenbelegPdf, journalExcel, kiAuslesen, kiTest,
} from "./util.js";

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};

const S = {
  account: null,
  view: "erfassen",
  betriebe: ls.get("sk_betriebe", []),
  active: ls.get("sk_active", null),
  data: {},            // key -> { config, journal, etag }
  jahr: String(new Date().getFullYear()),
  filter: { monat: "", kat: "", q: "" },
  draft: null,
  queue: [],
  browser: null,
};

const app = document.getElementById("app");
const modalEl = document.getElementById("modal");
const toastEl = document.getElementById("toast");
const busyEl = document.getElementById("busy");

const aktiv = () => S.betriebe.find((b) => b.key === S.active) || null;
const aktivData = () => (aktiv() ? S.data[aktiv().key] : null);
const ichBin = () => (S.account && (S.account.name || S.account.username)) || "unbekannt";
const istGbR = () => aktivData() && aktivData().config.typ === "gbr";

function speichereBetriebe() {
  ls.set("sk_betriebe", S.betriebe);
  ls.set("sk_active", S.active);
}

// ---------------------------------------------------------------------------
// UI-Helfer
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, typ = "ok") {
  toastEl.textContent = msg;
  toastEl.className = "toast show " + typ;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = "toast"), typ === "fehler" ? 7000 : 3500);
}
function busy(text) {
  if (text) { busyEl.querySelector("span").textContent = text; busyEl.classList.add("show"); }
  else busyEl.classList.remove("show");
}
function fehler(e) {
  console.error(e);
  busy(null);
  toast(e && e.message ? e.message : String(e), "fehler");
}
function modal(html) {
  modalEl.innerHTML = `<div class="modal-box">${html}</div>`;
  modalEl.classList.add("show");
}
function closeModal() {
  modalEl.classList.remove("show");
  modalEl.innerHTML = "";
  S.browser = null;
}
modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });

const opt = (val, label, sel) => `<option value="${esc(val)}" ${val === sel ? "selected" : ""}>${esc(label)}</option>`;

// ---------------------------------------------------------------------------
// Daten laden/speichern
// ---------------------------------------------------------------------------
async function ladeBetrieb(b, force = false) {
  if (S.data[b.key] && !force) return S.data[b.key];
  const cfg = await G.readJson(b.driveId, b.itemId, CONFIG_FILE);
  const jr = await G.readJson(b.driveId, b.itemId, JOURNAL_FILE);
  const d = {
    config: cfg.data || { name: b.name, kurz: b.kurz || b.name, typ: b.typ || "einzel", gesellschafter: [] },
    configEtag: cfg.etag,
    journal: jr.data || { version: 1, eintraege: [] },
    etag: jr.etag,
  };
  S.data[b.key] = d;
  // Anzeigename lokal aktuell halten
  b.name = d.config.name; b.kurz = d.config.kurz; b.typ = d.config.typ;
  speichereBetriebe();
  return d;
}

async function updateJournal(b, mutate) {
  for (let i = 0; i < 4; i++) {
    const jr = await G.readJson(b.driveId, b.itemId, JOURNAL_FILE);
    const data = jr.data || { version: 1, eintraege: [] };
    const result = mutate(data);
    try {
      const item = await G.writeJson(b.driveId, b.itemId, JOURNAL_FILE, data, jr.etag);
      S.data[b.key].journal = data;
      S.data[b.key].etag = item && item.eTag;
      return result;
    } catch (e) {
      if (e.status === 412) continue; // gleichzeitig geändert → neu lesen
      throw e;
    }
  }
  throw new Error("Das Journal wurde gleichzeitig geändert. Bitte noch einmal speichern.");
}

async function excelSpiegeln(b) {
  try {
    const d = S.data[b.key];
    const blob = journalExcel(d.journal, d.config);
    await G.uploadFile(b.driveId, b.itemId, `Journal_${d.config.kurz}.xlsx`, blob, { overwrite: true });
  } catch (e) {
    console.warn(e);
    toast("Hinweis: Die Excel-Kopie konnte nicht aktualisiert werden (ist sie gerade geöffnet?). Das Journal ist gespeichert.", "warn");
  }
}

function naechsteBelegnr(journal, jahr) {
  let max = 0;
  for (const e of journal.eintraege) {
    if (e.belegnr && e.belegnr.startsWith(jahr + "-")) max = Math.max(max, parseInt(e.belegnr.slice(5), 10) || 0);
  }
  return `${jahr}-${String(max + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Rendern
// ---------------------------------------------------------------------------
function render() {
  if (!S.account) return renderLogin();
  const b = aktiv();
  app.innerHTML = `
    <header class="top">
      <div class="brand"><img src="icons/icon-192.png" alt=""><span>Schuhkarton Steuer</span></div>
      ${S.betriebe.length ? `
        <div class="seg" role="tablist">
          ${S.betriebe.map((x) => `<button data-act="betrieb" data-key="${x.key}" class="${x.key === S.active ? "on" : ""}">${esc(x.name)}</button>`).join("")}
        </div>` : ""}
    </header>
    <main id="main"></main>
    <nav class="tabs">
      ${[["erfassen", "＋", "Erfassen"], ["journal", "☰", "Journal"], ["einstellungen", "⚙︎", "Einstellungen"]]
        .map(([v, i, l]) => `<button data-act="view" data-view="${v}" class="${S.view === v ? "on" : ""}"><b>${i}</b><span>${l}</span></button>`).join("")}
    </nav>`;
  const main = document.getElementById("main");
  if (!b && S.view !== "einstellungen") {
    main.innerHTML = `<section class="card leer">
      <h2>Willkommen</h2>
      <p>Verbinde zuerst einen Betriebsordner in OneDrive.</p>
      <button class="primary" data-act="view" data-view="einstellungen">Zu den Einstellungen</button></section>`;
    return;
  }
  if (S.view === "erfassen") renderErfassen(main);
  else if (S.view === "journal") renderJournal(main);
  else renderEinstellungen(main);
}

function renderLogin() {
  app.innerHTML = `
    <section class="login">
      <img src="icons/icon-512.png" alt="" class="logo">
      <h1>Schuhkarton Steuer</h1>
      <p>Belege fotografieren, ablegen und die EÜR vorbereiten.</p>
      <button class="primary big" data-act="login">Mit Microsoft anmelden</button>
      <p class="klein">Die Belege bleiben in deinem OneDrive.</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Erfassen
// ---------------------------------------------------------------------------
function renderErfassen(main) {
  const d = S.draft;
  if (!d) {
    main.innerHTML = `
      <section class="card">
        <h2>Neuer Beleg</h2>
        <div class="bigbtns">
          <button data-act="foto"><b>📷</b>Beleg fotografieren</button>
          <button data-act="datei"><b>📄</b>PDF oder Bild wählen</button>
          <button data-act="ohne"><b>✍️</b>Ohne Beleg<small>Eigenbeleg, Pauschale${istGbR() ? ", Einlage/Entnahme" : ""}</small></button>
        </div>
        ${S.queue.length ? `<p class="hinweis">Noch ${S.queue.length} Datei(en) in der Warteschlange.</p>` : ""}
      </section>`;
    return;
  }
  const ki = d.ki || {};
  const vorschau = d.pdfBlob
    ? `<div class="pdfname">📄 ${esc(d.pdfName)}</div>`
    : d.pages.length
      ? `<div class="thumbs">${d.pages.map((p, i) => `<div class="thumb"><img src="${p.dataUrl}" alt="Seite ${i + 1}"><button data-act="seite-weg" data-i="${i}" title="Seite entfernen">×</button></div>`).join("")}
         <button class="thumb add" data-act="foto">＋<small>Seite</small></button></div>`
      : "";
  main.innerHTML = `
    <section class="card">
      <div class="kopf">
        <h2>${d.mode === "ohne" ? "Buchung ohne Beleg" : "Beleg erfassen"}${d.queueInfo ? ` <small>(${esc(d.queueInfo)})</small>` : ""}</h2>
        <button class="link" data-act="verwerfen">Verwerfen</button>
      </div>
      ${vorschau}
      ${d.mode !== "ohne" ? kiLeiste(ki) : ""}
      ${formular(d.values || {}, { neu: true, ohne: d.mode === "ohne", unsicher: ki.unsicher || [] })}
    </section>`;
  bindFormular(main.querySelector("form"), d.values || {});
}

function kiLeiste(ki) {
  const key = ls.get("sk_apikey", "");
  if (!key) return `<p class="hinweis">Tipp: Mit einem API-Schlüssel in den Einstellungen liest die KI den Beleg automatisch aus.</p>`;
  if (ki.status === "laeuft") return `<div class="ki laeuft"><span class="spinner"></span> KI liest den Beleg …</div>`;
  if (ki.status === "ok") return `<div class="ki ok">✓ Von der KI ausgefüllt – bitte prüfen.${ki.begruendung ? `<br><small>${esc(ki.begruendung)}</small>` : ""}${ki.unsicher && ki.unsicher.length ? `<br><small>Unsicher: ${esc(ki.unsicher.join(", "))}</small>` : ""}</div>`;
  if (ki.status === "fehler") return `<div class="ki fehler">KI konnte nicht auslesen: ${esc(ki.info)} <button class="link" data-act="ki">Nochmal</button></div>`;
  return `<button class="sekundaer" data-act="ki">🔍 Mit KI auslesen</button>`;
}

function formular(v, { neu, ohne, unsicher = [] }) {
  const cfg = aktivData().config;
  const gbr = cfg.typ === "gbr";
  const art = v.art || "ausgabe";
  const ges = (cfg.gesellschafter || []).map((g) => g.name).filter(Boolean);
  const u = (f) => (unsicher.includes(f) ? "unsicher" : "");
  const arten = [["ausgabe", "Ausgabe"], ["einnahme", "Einnahme"]];
  if (gbr) arten.push(["einlage", "Geldeinlage aufs GbR-Konto"], ["entnahme", "Entnahme / Erstattung an Gesellschafterin"]);
  return `
  <form id="f" autocomplete="off">
    <label>Art<select name="art">${arten.map(([a, l]) => opt(a, l, art)).join("")}</select></label>
    <div class="zwei">
      <label class="${u("belegdatum")}">Belegdatum<input type="date" name="belegdatum" value="${esc(v.belegdatum || heute())}" required></label>
      <label class="${u("betrag")}">Betrag (€)<input name="betrag" inputmode="decimal" placeholder="0,00" value="${v.betragCent ? betragText(v.betragCent) : esc(v.betrag || "")}" required></label>
    </div>
    <div data-show="pauschale" class="pauschale">
      <label>Pauschale berechnen<select name="pauschaleTyp">
        ${opt("", "– keine –", v.pauschaleTyp)}${opt("km", "Fahrtkosten: km × 0,30 €", v.pauschaleTyp)}${opt("ho", "Homeoffice: Tage × 6 € (max. 1.260 €/Jahr)", v.pauschaleTyp)}
      </select></label>
      <label data-show="pauschaleMenge">Anzahl (km bzw. Tage)<input name="pauschaleMenge" inputmode="decimal" value="${esc(v.pauschaleMenge || "")}"></label>
    </div>
    <label data-show="partner" class="${u("partner")}"><span data-lbl="partner">Lieferant</span><input name="partner" value="${esc(v.partner || "")}"></label>
    <label data-show="gesellschafterin">Gesellschafterin<select name="gesellschafterin">${ges.map((n) => opt(n, n, v.gesellschafterin)).join("")}</select></label>
    <label data-show="entnahmeArt">Art der Entnahme<select name="entnahmeArt">
      ${opt("erstattung", "Erstattung vorgestreckter Ausgaben", v.entnahmeArt)}${opt("privat", "Privatentnahme", v.entnahmeArt)}
    </select></label>
    <label data-show="kategorie" class="${u("kategorie")}">Kategorie<select name="kategorie"></select></label>
    <label>Beschreibung<input name="beschreibung" value="${esc(v.beschreibung || "")}" placeholder="z. B. Jahresabo Zoom"></label>
    <label data-show="rechnungsnr" class="${u("rechnungsnr")}">Rechnungs-Nr. (optional)<input name="rechnungsnr" value="${esc(v.rechnungsnr || "")}"></label>
    <div class="zwei" data-show="status">
      <label>Status<select name="status">${opt("bezahlt", "bezahlt", v.status || "bezahlt")}${opt("offen", "noch offen", v.status)}</select></label>
      <label data-show="zahlungsdatum" class="${u("zahlungsdatum")}">Zahlungsdatum<input type="date" name="zahlungsdatum" value="${esc(v.zahlungsdatum || v.belegdatum || heute())}"></label>
    </div>
    <label data-show="bezahltVon">Bezahlt von<select name="bezahltVon">
      ${opt("betrieb", "GbR-Konto", v.bezahltVon || "betrieb")}${ges.map((n) => opt(n, `${n} privat`, v.bezahltVon)).join("")}
    </select></label>
    <label data-show="behandlung">Behandlung<select name="behandlung">
      ${opt("einlage", "Einlage (Standard)", v.behandlung || "einlage")}${opt("erstattung", "Wird vom GbR-Konto erstattet", v.behandlung)}${opt("sonderbetriebsausgabe", "Sonderbetriebsausgabe (trägt sie allein)", v.behandlung)}
    </select></label>
    <label data-show="eigenbeleg">Grund für Eigenbeleg<select name="eigenbelegGrund">${EIGENBELEG_GRUENDE.map((g) => opt(g, g, v.eigenbelegGrund)).join("")}</select></label>
    <input type="hidden" name="ohne" value="${ohne ? "1" : ""}">
    <div class="aktionen">
      <button type="submit" class="primary big">${neu ? "Speichern" : "Änderungen speichern"}</button>
    </div>
  </form>`;
}

function bindFormular(form, v) {
  const cfg = aktivData().config;
  const gbr = cfg.typ === "gbr";
  const ohne = form.ohne.value === "1";
  const katSel = form.kategorie;
  let letzteArt = null;

  const update = () => {
    const art = form.art.value;
    const handel = art === "ausgabe" || art === "einnahme";
    const show = {
      partner: handel,
      kategorie: handel,
      rechnungsnr: handel && !ohne,
      status: handel,
      zahlungsdatum: handel && form.status.value === "bezahlt",
      gesellschafterin: art === "einlage" || art === "entnahme",
      entnahmeArt: art === "entnahme",
      bezahltVon: gbr && art === "ausgabe",
      behandlung: gbr && art === "ausgabe" && form.bezahltVon.value !== "betrieb",
      eigenbeleg: ohne,
      pauschale: ohne && art === "ausgabe",
      pauschaleMenge: ohne && art === "ausgabe" && form.pauschaleTyp.value !== "",
    };
    form.querySelectorAll("[data-show]").forEach((el) => (el.style.display = show[el.dataset.show] ? "" : "none"));
    const lbl = form.querySelector('[data-lbl="partner"]');
    if (lbl) lbl.textContent = art === "einnahme" ? "Kunde / Zahlende:r" : "Lieferant / Empfänger:in";
    if (art !== letzteArt && handel) {
      const liste = art === "einnahme" ? KATEGORIEN_EINNAHME : KATEGORIEN_AUSGABE;
      const sel = liste.includes(v.kategorie) ? v.kategorie : katSel.value;
      katSel.innerHTML = `<option value="">– bitte wählen –</option>` + liste.map((k) => opt(k, k, sel)).join("");
    }
    letzteArt = art;
  };
  const pauschale = () => {
    const typ = form.pauschaleTyp.value;
    const n = parseFloat(String(form.pauschaleMenge.value).replace(",", ".")) || 0;
    if (!typ || !n) return;
    if (typ === "km") {
      form.betrag.value = betragText(Math.round(n * KM_PAUSCHALE_CENT));
      if (!form.kategorie.value) form.kategorie.value = "Reise- und Fahrtkosten";
    } else {
      form.betrag.value = betragText(Math.min(Math.round(n * HOMEOFFICE_TAG_CENT), HOMEOFFICE_MAX_CENT));
      if (!form.kategorie.value) form.kategorie.value = "Raumkosten, Homeoffice-Pauschale";
    }
    form.eigenbelegGrund.value = EIGENBELEG_GRUENDE[0];
  };
  form.addEventListener("change", (e) => {
    if (e.target.name === "belegdatum" && form.status.value === "bezahlt" && !form.dataset.zdGeaendert) form.zahlungsdatum.value = form.belegdatum.value;
    if (e.target.name === "zahlungsdatum") form.dataset.zdGeaendert = "1";
    if (e.target.name === "pauschaleTyp" || e.target.name === "pauschaleMenge") pauschale();
    update();
  });
  form.pauschaleMenge.addEventListener("input", pauschale);
  update();
}

function leseFormular(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  const art = f.art;
  const handel = art === "ausgabe" || art === "einnahme";
  const betragCent = parseBetrag(f.betrag);
  if (!f.belegdatum) throw new Error("Bitte ein Belegdatum angeben.");
  if (!(betragCent > 0)) throw new Error("Bitte einen gültigen Betrag angeben.");
  if (handel && !f.kategorie) throw new Error("Bitte eine Kategorie wählen.");
  if (handel && !f.partner.trim()) throw new Error(art === "einnahme" ? "Bitte Kunde/Zahlende:n angeben." : "Bitte Lieferant/Empfänger:in angeben.");
  if (!handel && !f.gesellschafterin) throw new Error("Bitte in den Betriebsdaten Gesellschafterinnen eintragen.");
  const status = handel ? f.status : "bezahlt";
  const gbrAusgabe = istGbR() && art === "ausgabe";
  const bezahltVon = gbrAusgabe ? f.bezahltVon : null;
  let pauschale = null;
  if (f.pauschaleTyp && f.pauschaleMenge) {
    pauschale = f.pauschaleTyp === "km" ? `${f.pauschaleMenge} km × 0,30 €` : `${f.pauschaleMenge} Tage × 6,00 € (Homeoffice)`;
  }
  return {
    art,
    belegdatum: f.belegdatum,
    betragCent,
    partner: handel ? f.partner.trim() : "",
    kategorie: handel ? f.kategorie : "",
    beschreibung: (f.beschreibung || "").trim(),
    rechnungsnr: handel ? (f.rechnungsnr || "").trim() : "",
    status,
    zahlungsdatum: status === "bezahlt" ? (handel ? f.zahlungsdatum || f.belegdatum : f.belegdatum) : null,
    bezahltVon,
    behandlung: bezahltVon && bezahltVon !== "betrieb" ? f.behandlung : null,
    gesellschafterin: handel ? "" : f.gesellschafterin,
    entnahmeArt: art === "entnahme" ? f.entnahmeArt : null,
    eigenbelegGrund: f.ohne === "1" ? f.eigenbelegGrund : null,
    pauschale,
  };
}

function neuerEntwurf(mode) {
  S.draft = { id: uuid(), mode, pages: [], pdfBlob: null, pdfName: "", values: {}, ki: {} };
}

function sichereEntwurfsWerte() {
  const form = document.getElementById("f");
  if (!S.draft || !form) return;
  const f = Object.fromEntries(new FormData(form).entries());
  const v = { ...f };
  const c = parseBetrag(f.betrag);
  if (c > 0) v.betragCent = c;
  S.draft.values = { ...S.draft.values, ...v };
}

async function fotosHinzufuegen(files) {
  if (!S.draft) neuerEntwurf("beleg");
  else sichereEntwurfsWerte();
  busy("Bild wird vorbereitet …");
  try {
    for (const f of files) S.draft.pages.push(await compressImage(f));
  } finally { busy(null); }
  render();
  if (S.draft.pages.length === 1) kiStarten();
}

async function naechsteDatei() {
  const f = S.queue.shift();
  if (!f) return;
  const rest = S.queue.length;
  neuerEntwurf("beleg");
  if (rest > 0 || S.draft.queueTotal) S.draft.queueInfo = `noch ${rest} weitere`;
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
    S.draft.pdfBlob = f;
    S.draft.pdfName = f.name;
    render();
  } else {
    busy("Bild wird vorbereitet …");
    try { S.draft.pages.push(await compressImage(f)); } finally { busy(null); }
    render();
  }
  kiStarten();
}

async function kiStarten() {
  const key = ls.get("sk_apikey", "");
  const d = S.draft;
  if (!key || !d || (!d.pdfBlob && !d.pages.length)) return;
  sichereEntwurfsWerte();
  d.ki = { status: "laeuft" };
  render();
  try {
    const r = await kiAuslesen({ apiKey: key, modell: ls.get("sk_modell", KI_STANDARD), pages: d.pages, pdfBlob: d.pdfBlob, config: aktivData().config });
    if (S.draft !== d) return;
    const v = d.values;
    if (r.art === "einnahme" || r.art === "ausgabe") v.art = r.art;
    if (r.belegdatum) v.belegdatum = r.belegdatum;
    if (typeof r.betrag === "number" && r.betrag > 0) v.betragCent = Math.round(r.betrag * 100);
    if (r.partner) v.partner = r.partner;
    if (r.rechnungsnr) v.rechnungsnr = r.rechnungsnr;
    if (r.kategorie) v.kategorie = r.kategorie;
    if (r.beschreibung) v.beschreibung = r.beschreibung;
    if (r.bezahlt === false) v.status = "offen";
    else { v.status = "bezahlt"; v.zahlungsdatum = r.zahlungsdatum || r.belegdatum || v.zahlungsdatum; }
    d.ki = { status: "ok", begruendung: r.begruendung, unsicher: Array.isArray(r.unsicher) ? r.unsicher : [] };
    if (r.waehrung && r.waehrung !== "EUR") d.ki.unsicher.push("betrag (Währung " + r.waehrung + ")");
  } catch (e) {
    if (S.draft !== d) return;
    d.ki = { status: "fehler", info: e.message };
  }
  if (S.view === "erfassen") render();
}

async function speichereNeu(form) {
  const b = aktiv();
  const dat = aktivData();
  let e;
  try { e = leseFormular(form); } catch (err) { return toast(err.message, "fehler"); }
  const d = S.draft;
  const ohne = d.mode === "ohne";
  if (!ohne && !d.pdfBlob && !d.pages.length) return toast("Bitte zuerst einen Beleg fotografieren oder wählen.", "fehler");
  busy("Speichere Beleg …");
  try {
    // aktuelles Journal für die Beleg-Nr.
    await ladeBetrieb(b, true);
    const jahr = e.belegdatum.slice(0, 4);
    e.id = d.id;
    e.belegnr = naechsteBelegnr(S.data[b.key].journal, jahr);
    e.eigenbeleg = ohne;
    e.erfasstVon = ichBin();
    e.erfasstAm = new Date().toISOString();
    e.storniert = false;
    e.historie = [];
    const blob = ohne ? eigenbelegPdf(e, dat.config, ichBin()) : d.pdfBlob || bilderZuPdf(d.pages);
    busy("Lade Beleg in OneDrive hoch …");
    const ordner = await G.ensurePath(b.driveId, b.itemId, [BELEGE_FOLDER, jahr]);
    const item = await G.uploadFile(b.driveId, ordner, dateiname(e, dat.config.kurz), blob);
    e.datei = { id: item.id, name: item.name, webUrl: item.webUrl, driveId: b.driveId };
    busy("Trage ins Journal ein …");
    const nr = await updateJournal(b, (j) => {
      if (j.eintraege.some((x) => x.belegnr === e.belegnr)) e.belegnr = naechsteBelegnr(j, jahr);
      j.eintraege.push(e);
      return e.belegnr;
    });
    busy("Aktualisiere Excel-Kopie …");
    await excelSpiegeln(b);
    busy(null);
    toast(`Gespeichert als ${nr}`);
    S.draft = null;
    render();
    if (S.queue.length) naechsteDatei();
  } catch (err) { fehler(err); }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------
function eintraegeJahr() {
  const d = aktivData();
  return d.journal.eintraege.filter((e) => (e.zahlungsdatum || e.belegdatum).startsWith(S.jahr));
}

function renderJournal(main) {
  const d = aktivData();
  const cfg = d.config;
  const jahre = [...new Set([String(new Date().getFullYear()), ...d.journal.eintraege.map((e) => (e.zahlungsdatum || e.belegdatum).slice(0, 4))])].sort().reverse();
  const alle = eintraegeJahr();
  const f = S.filter;
  const q = f.q.toLowerCase();
  const liste = alle
    .filter((e) => !f.monat || (e.zahlungsdatum || e.belegdatum).slice(5, 7) === f.monat)
    .filter((e) => !f.kat || e.kategorie === f.kat)
    .filter((e) => !q || [e.partner, e.beschreibung, e.kategorie, e.belegnr, e.gesellschafterin, e.rechnungsnr].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (b.zahlungsdatum || b.belegdatum).localeCompare(a.zahlungsdatum || a.belegdatum) || (b.belegnr || "").localeCompare(a.belegnr || ""));

  const gueltig = alle.filter((e) => !e.storniert);
  const sum = (arr) => arr.reduce((s, e) => s + e.betragCent, 0);
  const einnahmen = sum(gueltig.filter((e) => e.art === "einnahme" && e.status === "bezahlt"));
  const ausgaben = sum(gueltig.filter((e) => e.art === "ausgabe" && e.status === "bezahlt" && e.behandlung !== "sonderbetriebsausgabe"));
  const offen = gueltig.filter((e) => e.status === "offen");
  const monate = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  const monNamen = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

  main.innerHTML = `
    <section class="card">
      <div class="kopf">
        <h2>Journal ${esc(cfg.name)}</h2>
        <select data-act="jahr">${jahre.map((j) => opt(j, j, S.jahr)).join("")}</select>
      </div>
      <div class="summen">
        <div><small>Einnahmen</small><b class="plus">${euro(einnahmen)}</b></div>
        <div><small>Ausgaben</small><b class="minus">${euro(ausgaben)}</b></div>
        <div><small>Überschuss</small><b>${euro(einnahmen - ausgaben)}</b></div>
      </div>
      ${offen.length ? `<p class="hinweis">${offen.length} offene Posten (${euro(sum(offen))}) – zählen erst bei Zahlung.</p>` : ""}
      ${cfg.typ === "gbr" ? gesellschafterBox(gueltig, cfg) : ""}
      <p class="klein">Vorläufige Summen nach Zahlungsdatum. Die vollständige EÜR-Auswertung folgt.</p>
    </section>
    <section class="card">
      <div class="filter">
        <select data-flt="monat">${opt("", "Alle Monate", f.monat)}${monate.map((m, i) => opt(m, monNamen[i], f.monat)).join("")}</select>
        <select data-flt="kat">${opt("", "Alle Kategorien", f.kat)}${[...KATEGORIEN_EINNAHME, ...KATEGORIEN_AUSGABE].map((k) => opt(k, k, f.kat)).join("")}</select>
        <input data-flt="q" placeholder="Suchen …" value="${esc(f.q)}">
      </div>
      ${liste.length ? `<ul class="liste">${liste.map(zeile).join("")}</ul>` : `<p class="leer">Keine Einträge.</p>`}
    </section>`;
}

function gesellschafterBox(gueltig, cfg) {
  const rows = (cfg.gesellschafter || []).filter((g) => g.name).map((g) => {
    const n = g.name;
    const s = (fn) => gueltig.filter(fn).reduce((a, e) => a + e.betragCent, 0);
    const einlagen = s((e) => (e.art === "ausgabe" && e.bezahltVon === n && e.behandlung === "einlage") || (e.art === "einlage" && e.gesellschafterin === n));
    const vorgestreckt = s((e) => e.art === "ausgabe" && e.bezahltVon === n && e.behandlung === "erstattung");
    const erstattet = s((e) => e.art === "entnahme" && e.gesellschafterin === n && e.entnahmeArt === "erstattung");
    const entnahmen = s((e) => e.art === "entnahme" && e.gesellschafterin === n && e.entnahmeArt === "privat");
    const sba = s((e) => e.art === "ausgabe" && e.bezahltVon === n && e.behandlung === "sonderbetriebsausgabe");
    return `<div class="gesk"><b>${esc(n)} <small>(${esc(g.anteil)} %)</small></b>
      <div><small>Einlagen</small>${euro(einlagen)}</div>
      <div><small>Offen zu erstatten</small>${euro(vorgestreckt - erstattet)}</div>
      <div><small>Privatentnahmen</small>${euro(entnahmen)}</div>
      <div><small>Sonderbetriebsausg.</small>${euro(sba)}</div></div>`;
  });
  if (!rows.length) return "";
  return `<div class="gesgrid">${rows.join("")}</div>`;
}

function zeile(e) {
  const minus = e.art === "ausgabe" || e.art === "entnahme";
  const titel = e.partner || (e.art === "einlage" ? `Einlage ${e.gesellschafterin}` : `Entnahme ${e.gesellschafterin}`);
  const badges = [];
  if (e.storniert) badges.push(`<i class="b rot">storniert</i>`);
  if (e.status === "offen") badges.push(`<i class="b gelb">offen</i>`);
  if (e.eigenbeleg) badges.push(`<i class="b">Eigenbeleg</i>`);
  if (e.behandlung === "einlage") badges.push(`<i class="b blau">Einlage ${esc(e.bezahltVon)}</i>`);
  if (e.behandlung === "erstattung") badges.push(`<i class="b blau">vorgestreckt ${esc(e.bezahltVon)}</i>`);
  if (e.behandlung === "sonderbetriebsausgabe") badges.push(`<i class="b blau">SBA ${esc(e.bezahltVon)}</i>`);
  return `<li data-act="detail" data-id="${e.id}" class="${e.storniert ? "storno" : ""}">
    <div class="l1"><span>${esc(titel)}</span><b class="${minus ? "minus" : "plus"}">${minus ? "−" : "+"}${euro(e.betragCent)}</b></div>
    <div class="l2"><span>${datumDE(e.zahlungsdatum || e.belegdatum)} · ${esc(e.belegnr)} · ${esc(e.kategorie || (e.art === "einlage" ? "Einlage" : "Entnahme"))}</span>${badges.join("")}</div>
  </li>`;
}

function zeigeDetail(id) {
  const e = aktivData().journal.eintraege.find((x) => x.id === id);
  if (!e) return;
  const artText = { ausgabe: "Ausgabe", einnahme: "Einnahme", einlage: "Geldeinlage", entnahme: "Entnahme" }[e.art];
  const reihe = (l, w) => (w ? `<tr><th>${l}</th><td>${w}</td></tr>` : "");
  modal(`
    <div class="kopf"><h2>${esc(e.belegnr)} · ${artText}</h2><button class="link" data-act="modal-zu">Schließen</button></div>
    <table class="detail">
      ${reihe("Betrag", euro(e.betragCent))}
      ${reihe("Belegdatum", datumDE(e.belegdatum))}
      ${reihe("Status", e.status === "bezahlt" ? `bezahlt am ${datumDE(e.zahlungsdatum)}` : "offen")}
      ${reihe(e.art === "einnahme" ? "Kunde" : "Lieferant", esc(e.partner))}
      ${reihe("Gesellschafterin", esc(e.gesellschafterin))}
      ${reihe("Kategorie", esc(e.kategorie))}
      ${reihe("Beschreibung", esc(e.beschreibung))}
      ${reihe("Rechnungs-Nr.", esc(e.rechnungsnr))}
      ${reihe("Bezahlt von", e.bezahltVon && e.bezahltVon !== "betrieb" ? esc(e.bezahltVon) + " privat" : "")}
      ${reihe("Behandlung", esc({ einlage: "Einlage", erstattung: "wird erstattet", sonderbetriebsausgabe: "Sonderbetriebsausgabe" }[e.behandlung] || ""))}
      ${reihe("Entnahme", esc({ erstattung: "Erstattung", privat: "Privatentnahme" }[e.entnahmeArt] || ""))}
      ${reihe("Eigenbeleg", e.eigenbeleg ? esc(e.eigenbelegGrund) + (e.pauschale ? `<br><small>${esc(e.pauschale)}</small>` : "") : "")}
      ${reihe("Erfasst", `${esc(e.erfasstVon)}, ${new Date(e.erfasstAm).toLocaleString("de-DE")}`)}
      ${e.storniert ? reihe("Storniert", esc(e.stornoGrund || "")) : ""}
      ${(e.historie || []).length ? reihe("Änderungen", e.historie.map((h) => `${new Date(h.am).toLocaleDateString("de-DE")} ${esc(h.von)}: ${esc(h.felder.join(", "))}`).join("<br>")) : ""}
    </table>
    <div class="aktionen">
      ${e.datei && e.datei.webUrl ? `<a class="sekundaer btn" href="${esc(e.datei.webUrl)}" target="_blank" rel="noopener">📄 Beleg öffnen</a>` : ""}
      ${!e.storniert ? `<button class="sekundaer" data-act="bearbeiten" data-id="${e.id}">Bearbeiten</button>
      <button class="gefahr" data-act="storno" data-id="${e.id}">Stornieren</button>` : ""}
    </div>`);
}

function zeigeBearbeiten(id) {
  const e = aktivData().journal.eintraege.find((x) => x.id === id);
  if (!e) return;
  modal(`
    <div class="kopf"><h2>${esc(e.belegnr)} bearbeiten</h2><button class="link" data-act="modal-zu">Abbrechen</button></div>
    ${formular(e, { neu: false, ohne: e.eigenbeleg })}`);
  const form = modalEl.querySelector("form");
  form.dataset.editId = id;
  bindFormular(form, e);
}

async function speichereBearbeitung(form) {
  const b = aktiv();
  const id = form.dataset.editId;
  let neu;
  try { neu = leseFormular(form); } catch (err) { return toast(err.message, "fehler"); }
  busy("Speichere Änderungen …");
  try {
    const alt = await updateJournal(b, (j) => {
      const e = j.eintraege.find((x) => x.id === id);
      if (!e) throw new Error("Eintrag nicht gefunden.");
      const vorher = { ...e };
      if (!neu.eigenbelegGrund) delete neu.eigenbelegGrund;
      if (!neu.pauschale) delete neu.pauschale;
      const felder = Object.keys(neu).filter((k) => JSON.stringify(neu[k] ?? null) !== JSON.stringify(e[k] ?? null));
      Object.assign(e, neu);
      if (felder.length) (e.historie = e.historie || []).push({ am: new Date().toISOString(), von: ichBin(), felder });
      return { vorher, nachher: { ...e } };
    });
    // Datei umbenennen, falls sich Datum/Partner/Betrag geändert haben
    const n = alt.nachher;
    if (n.datei && n.datei.id) {
      const name = dateiname(n, aktivData().config.kurz);
      if (name !== n.datei.name) {
        try {
          const it = await G.renameItem(n.datei.driveId || b.driveId, n.datei.id, name);
          await updateJournal(b, (j) => { const e = j.eintraege.find((x) => x.id === id); e.datei.name = it.name; e.datei.webUrl = it.webUrl; });
        } catch (er) { console.warn(er); }
      }
    }
    await excelSpiegeln(b);
    busy(null);
    closeModal();
    toast("Änderungen gespeichert");
    render();
  } catch (err) { fehler(err); }
}

async function storniere(id) {
  const grund = prompt("Grund für die Stornierung (z. B. doppelt erfasst):");
  if (grund === null) return;
  const b = aktiv();
  busy("Storniere …");
  try {
    await updateJournal(b, (j) => {
      const e = j.eintraege.find((x) => x.id === id);
      e.storniert = true;
      e.stornoGrund = grund;
      (e.historie = e.historie || []).push({ am: new Date().toISOString(), von: ichBin(), felder: ["storniert"] });
    });
    await excelSpiegeln(b);
    busy(null);
    closeModal();
    toast("Storniert. Der Beleg bleibt zur Nachvollziehbarkeit erhalten.");
    render();
  } catch (err) { fehler(err); }
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
function renderEinstellungen(main) {
  const key = ls.get("sk_apikey", "");
  const modell = ls.get("sk_modell", KI_STANDARD);
  main.innerHTML = `
    <section class="card">
      <h2>Betriebe</h2>
      ${S.betriebe.length ? `<ul class="betriebe">${S.betriebe.map((b) => `
        <li><div><b>${esc(b.name)}</b><small>${b.typ === "gbr" ? "GbR" : "Einzelunternehmen"} · Ordner: ${esc(b.ordnerName || "")}</small></div>
          <div class="knoepfe"><button class="link" data-act="cfg" data-key="${b.key}">Betriebsdaten</button>
          <button class="link rot" data-act="trennen" data-key="${b.key}">Trennen</button></div></li>`).join("")}</ul>`
        : `<p>Noch kein Betrieb verbunden.</p>`}
      <button class="primary" data-act="verbinden">＋ Betriebsordner verbinden</button>
      <p class="klein">„Trennen“ entfernt die Verbindung nur auf diesem Gerät. Daten in OneDrive bleiben unverändert.</p>
    </section>
    <section class="card">
      <h2>KI-Auslesen</h2>
      <label>API-Schlüssel (Anthropic)<input id="apikey" type="password" value="${esc(key)}" placeholder="sk-ant-…" autocomplete="off"></label>
      <label>Modell<select id="modell">${KI_MODELLE.map((m) => opt(m.id, m.label, modell)).join("")}</select></label>
      <div class="aktionen"><button class="primary" data-act="ki-speichern">Speichern</button><button class="sekundaer" data-act="ki-testen">Testen</button></div>
      <p class="klein">Der Schlüssel wird nur auf diesem Gerät gespeichert.</p>
    </section>
    <section class="card">
      <h2>Konto</h2>
      <p>Angemeldet als <b>${esc(ichBin())}</b><br><small>${esc(S.account.username || "")}</small></p>
      <button class="sekundaer" data-act="logout">Abmelden</button>
      <p class="klein">Version ${VERSION}</p>
    </section>`;
}

function zeigeVerbinden() {
  modal(`
    <div class="kopf"><h2>Betriebsordner verbinden</h2><button class="link" data-act="modal-zu">Abbrechen</button></div>
    <p>Wo liegt der Ordner des Betriebs?</p>
    <button class="primary big" data-act="browse-mein">In meinem OneDrive suchen</button>
    <p class="oder">oder</p>
    <label>Freigabelink einfügen (für geteilte Ordner)<input id="sharelink" placeholder="https://1drv.ms/… oder https://onedrive.live.com/…"></label>
    <button class="sekundaer" data-act="browse-link">Link öffnen</button>
    <p class="klein">Den Freigabelink findest du in der Einladungs-E-Mail von OneDrive („Öffnen“-Button → Link kopieren) oder die Besitzerin erstellt ihn über „Teilen → Link kopieren“.</p>`);
}

async function browserStart(start) {
  S.browser = { stack: [start], ordner: [] };
  await browserLaden();
}

async function browserLaden() {
  const top = S.browser.stack[S.browser.stack.length - 1];
  modal(`<p><span class="spinner"></span> Lade Ordner …</p>`);
  try {
    S.browser.ordner = await G.listFolders(top.driveId, top.id);
    renderBrowser();
  } catch (e) { closeModal(); fehler(e); }
}

function renderBrowser() {
  const br = S.browser;
  const top = br.stack[br.stack.length - 1];
  modal(`
    <div class="kopf"><h2>Ordner wählen</h2><button class="link" data-act="modal-zu">Abbrechen</button></div>
    <div class="crumbs">${br.stack.map((s, i) => `<button class="link" data-act="crumb" data-i="${i}">${esc(s.name)}</button>`).join(" › ")}</div>
    <ul class="ordner">
      ${br.ordner.map((o, i) => `<li data-act="ordner" data-i="${i}">📁 ${esc(o.name)}${o.geteilt ? " <small>(geteilt)</small>" : ""}</li>`).join("") || `<li class="leer">Keine Unterordner</li>`}
    </ul>
    <div class="aktionen">
      <button class="primary" data-act="ordner-waehlen" ${top.id ? "" : "disabled"}>„${esc(top.name)}“ verwenden</button>
    </div>
    <p class="klein">Wähle den Betriebsordner selbst, z. B. „Privat“ oder „regulationwiseGbR“.</p>`);
}

async function ordnerGewaehlt() {
  const top = S.browser.stack[S.browser.stack.length - 1];
  closeModal();
  const vorhanden = S.betriebe.find((b) => b.itemId === top.id);
  if (vorhanden) { S.active = vorhanden.key; speichereBetriebe(); toast("Dieser Ordner ist bereits verbunden."); return render(); }
  busy("Prüfe Ordner …");
  try {
    const cfg = await G.readJson(top.driveId, top.id, CONFIG_FILE);
    busy(null);
    const b = { key: uuid(), driveId: top.driveId, itemId: top.id, ordnerName: top.name, name: top.name, kurz: top.name, typ: /gbr/i.test(top.name) ? "gbr" : "einzel" };
    if (cfg.data) {
      Object.assign(b, { name: cfg.data.name, kurz: cfg.data.kurz, typ: cfg.data.typ });
      S.betriebe.push(b);
      S.active = b.key;
      speichereBetriebe();
      await ladeBetrieb(b, true);
      toast(`„${b.name}“ verbunden`);
      S.view = "erfassen";
      render();
    } else {
      zeigeConfig(b, true);
    }
  } catch (e) { fehler(e); }
}

function zeigeConfig(b, neu) {
  const c = (S.data[b.key] && S.data[b.key].config) || {
    name: /gbr/i.test(b.name) ? "regulation.wise GbR" : b.name,
    kurz: /gbr/i.test(b.name) ? "GbR" : b.name,
    typ: b.typ,
    steuernummer: "",
    kleinunternehmer: true,
    gesellschafter: [{ name: "", anteil: 50 }, { name: "", anteil: 50 }],
  };
  const ges = c.gesellschafter && c.gesellschafter.length ? c.gesellschafter : [{ name: "", anteil: 50 }, { name: "", anteil: 50 }];
  modal(`
    <div class="kopf"><h2>${neu ? "Neuen Betrieb einrichten" : "Betriebsdaten"}</h2><button class="link" data-act="modal-zu">Abbrechen</button></div>
    ${neu ? `<p class="hinweis">In diesem Ordner gibt es noch keine Betriebsdaten. Sie werden einmalig angelegt und gelten für alle, die den Ordner nutzen.</p>` : ""}
    <form id="cfgform">
      <label>Name des Betriebs (Anzeige)<input name="name" value="${esc(c.name)}" required></label>
      <label>Kurzname für Dateinamen<input name="kurz" value="${esc(c.kurz)}" required></label>
      <label>Rechtsform<select name="typ">${opt("einzel", "Einzelunternehmen", c.typ)}${opt("gbr", "GbR", c.typ)}</select></label>
      <label>Steuernummer (optional)<input name="steuernummer" value="${esc(c.steuernummer || "")}"></label>
      <label class="check"><input type="checkbox" name="kleinunternehmer" ${c.kleinunternehmer !== false ? "checked" : ""}> Kleinunternehmerregelung (keine Umsatzsteuer)</label>
      <fieldset data-gbr>
        <legend>Gesellschafterinnen und Anteile</legend>
        ${ges.map((g, i) => `<div class="zwei"><label>Name<input name="g${i}name" value="${esc(g.name)}"></label><label>Anteil %<input name="g${i}anteil" inputmode="decimal" value="${esc(g.anteil)}"></label></div>`).join("")}
      </fieldset>
      <div class="aktionen"><button type="submit" class="primary big">Speichern</button></div>
    </form>`);
  const form = modalEl.querySelector("#cfgform");
  const toggle = () => (form.querySelector("[data-gbr]").style.display = form.typ.value === "gbr" ? "" : "none");
  form.typ.addEventListener("change", toggle);
  toggle();
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form).entries());
    const cfg = {
      ...c,
      name: f.name.trim(),
      kurz: f.kurz.trim().replace(/[\\/:*?"<>|#%\s]+/g, "-"),
      typ: f.typ,
      steuernummer: f.steuernummer.trim(),
      kleinunternehmer: !!f.kleinunternehmer,
      gesellschafter: f.typ === "gbr" ? ges.map((_, i) => ({ name: (f[`g${i}name`] || "").trim(), anteil: parseFloat(String(f[`g${i}anteil`]).replace(",", ".")) || 0 })).filter((g) => g.name) : [],
      geaendertVon: ichBin(),
      geaendertAm: new Date().toISOString(),
    };
    if (cfg.typ === "gbr") {
      const summe = cfg.gesellschafter.reduce((s, g) => s + g.anteil, 0);
      if (cfg.gesellschafter.length < 2) return toast("Bitte beide Gesellschafterinnen eintragen.", "fehler");
      if (Math.abs(summe - 100) > 0.01) return toast("Die Anteile müssen zusammen 100 % ergeben.", "fehler");
    }
    busy("Speichere Betriebsdaten …");
    try {
      const etag = S.data[b.key] ? S.data[b.key].configEtag : null;
      const item = await G.writeJson(b.driveId, b.itemId, CONFIG_FILE, cfg, etag);
      Object.assign(b, { name: cfg.name, kurz: cfg.kurz, typ: cfg.typ });
      if (!S.betriebe.includes(b)) S.betriebe.push(b);
      S.active = b.key;
      speichereBetriebe();
      await ladeBetrieb(b, true);
      S.data[b.key].configEtag = item && item.eTag;
      busy(null);
      closeModal();
      toast("Betriebsdaten gespeichert");
      if (neu) S.view = "erfassen";
      render();
    } catch (e) {
      if (e.status === 412) return fehler(new Error("Die Betriebsdaten wurden inzwischen von jemand anderem geändert. Bitte neu öffnen."));
      fehler(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------
const camInput = document.getElementById("cam");
const dateiInput = document.getElementById("dateien");

camInput.addEventListener("change", () => {
  const files = [...camInput.files];
  camInput.value = "";
  if (files.length) fotosHinzufuegen(files).catch(fehler);
});
dateiInput.addEventListener("change", () => {
  const files = [...dateiInput.files];
  dateiInput.value = "";
  if (!files.length) return;
  S.queue.push(...files);
  if (!S.draft) naechsteDatei().catch(fehler);
  else { sichereEntwurfsWerte(); render(); }
});

document.addEventListener("submit", (ev) => {
  const form = ev.target;
  if (form.id !== "f") return;
  ev.preventDefault();
  if (form.dataset.editId) speichereBearbeitung(form);
  else speichereNeu(form);
});

document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.dataset.act === "jahr") { S.jahr = t.value; render(); }
  if (t.dataset.flt) { S.filter[t.dataset.flt] = t.value; render(); }
});
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.dataset.flt === "q") {
    S.filter.q = t.value;
    const pos = t.selectionStart;
    render();
    const neu = document.querySelector('[data-flt="q"]');
    if (neu) { neu.focus(); neu.setSelectionRange(pos, pos); }
  }
});

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT") return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case "login": await G.login(); break;
      case "logout": if (confirm("Wirklich abmelden?")) await G.logout(); break;
      case "view":
        if (S.view === "erfassen") sichereEntwurfsWerte();
        S.view = el.dataset.view; render(); break;
      case "betrieb":
        if (S.draft && !confirm("Der angefangene Beleg wird verworfen. Fortfahren?")) return;
        S.draft = null; S.queue = [];
        S.active = el.dataset.key; speichereBetriebe();
        busy("Lade …"); await ladeBetrieb(aktiv(), true); busy(null); render(); break;
      case "foto": camInput.click(); break;
      case "datei": dateiInput.click(); break;
      case "ohne": neuerEntwurf("ohne"); render(); break;
      case "verwerfen":
        if (confirm("Diesen Beleg verwerfen?")) { S.draft = null; render(); if (S.queue.length) naechsteDatei(); }
        break;
      case "seite-weg": sichereEntwurfsWerte(); S.draft.pages.splice(+el.dataset.i, 1); render(); break;
      case "ki": kiStarten(); break;
      case "detail": zeigeDetail(el.dataset.id); break;
      case "bearbeiten": zeigeBearbeiten(el.dataset.id); break;
      case "storno": await storniere(el.dataset.id); break;
      case "modal-zu": closeModal(); break;
      case "verbinden": zeigeVerbinden(); break;
      case "browse-mein": {
        const d = await G.myDrive();
        await browserStart({ name: "Mein OneDrive", driveId: d.id, id: null });
        break;
      }
      case "browse-link": {
        const url = document.getElementById("sharelink").value;
        if (!/^https?:\/\//.test(url)) return toast("Bitte einen vollständigen Link einfügen.", "fehler");
        busy("Öffne Freigabe …");
        const start = await G.resolveShareLink(url);
        busy(null);
        await browserStart(start);
        break;
      }
      case "crumb": S.browser.stack = S.browser.stack.slice(0, +el.dataset.i + 1); await browserLaden(); break;
      case "ordner": S.browser.stack.push(S.browser.ordner[+el.dataset.i]); await browserLaden(); break;
      case "ordner-waehlen": await ordnerGewaehlt(); break;
      case "cfg": {
        const b = S.betriebe.find((x) => x.key === el.dataset.key);
        busy("Lade …"); await ladeBetrieb(b, true); busy(null);
        zeigeConfig(b, false); break;
      }
      case "trennen": {
        const b = S.betriebe.find((x) => x.key === el.dataset.key);
        if (!confirm(`Verbindung zu „${b.name}“ auf diesem Gerät entfernen?`)) return;
        S.betriebe = S.betriebe.filter((x) => x !== b);
        if (S.active === b.key) S.active = S.betriebe[0] ? S.betriebe[0].key : null;
        speichereBetriebe(); render(); break;
      }
      case "ki-speichern":
        ls.set("sk_apikey", document.getElementById("apikey").value.trim());
        ls.set("sk_modell", document.getElementById("modell").value);
        toast("KI-Einstellungen gespeichert"); break;
      case "ki-testen": {
        const k = document.getElementById("apikey").value.trim();
        if (!k) return toast("Bitte zuerst einen Schlüssel eintragen.", "fehler");
        busy("Teste Verbindung …");
        await kiTest(k, document.getElementById("modell").value);
        busy(null); toast("Verbindung zur KI funktioniert ✓"); break;
      }
    }
  } catch (e) { fehler(e); }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function start() {
  try {
    S.account = await G.initAuth();
  } catch (e) {
    console.error(e);
    toast("Anmeldung fehlgeschlagen: " + e.message, "fehler");
  }
  if (S.account) {
    if (!aktiv() && S.betriebe.length) { S.active = S.betriebe[0].key; speichereBetriebe(); }
    if (aktiv()) {
      busy("Lade Daten …");
      try { await ladeBetrieb(aktiv(), true); } catch (e) { fehler(e); }
      busy(null);
    } else S.view = "einstellungen";
  }
  render();
})();
