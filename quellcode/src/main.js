// Schuhkarton Steuer – Oberfläche und Ablauf
import {
  VERSION, CONFIG_FILE, JOURNAL_FILE, BELEGE_FOLDER, KI_MODELLE, KI_STANDARD, VERBINDUNGEN_FILE, REDIRECT_URI,
  KATEGORIEN_AUSGABE, KATEGORIEN_EINNAHME, EIGENBELEG_GRUENDE,
  KM_PAUSCHALE_CENT, HOMEOFFICE_TAG_CENT, HOMEOFFICE_MAX_CENT,
  GWG_GRENZE_BRUTTO_CENT, KU_GRENZE_VORJAHR_CENT, KU_GRENZE_LAUFEND_CENT, VORLAGEN_FILE,
} from "./config.js";
import { aufteilen, migriereKategorien, euer, ergebnis, gesellschafterUebersicht, faelligePerioden, zahlJahr } from "./euer.js";
import * as G from "./graph.js";
import {
  esc, heute, uuid, euro, betragText, parseBetrag, datumDE, dateiname,
  compressImage, bilderZuPdf, eigenbelegPdf, journalExcel, kiAuslesen, kiTest, euerPdf,
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

// --- Rollen ------------------------------------------------------------------
const meineMail = () => ((S.account && S.account.username) || "").toLowerCase();
// Ohne festgelegte Admins (ältere Betriebsdaten) dürfen alle verwalten, bis Admins eingetragen sind
const istAdmin = (cfg) => !!cfg && (!Array.isArray(cfg.admins) || !cfg.admins.length || cfg.admins.map((x) => x.toLowerCase()).includes(meineMail()));
const cfgVon = (b) => (S.data[b.key] ? S.data[b.key].config : null);

// --- Verbindungen geräteübergreifend im persönlichen App-Ordner -----------------
const verbindungsDaten = () =>
  S.betriebe.map(({ driveId, itemId, ordnerName, name, kurz, typ }) => ({ driveId, itemId, ordnerName, name, kurz, typ }));

async function ladeVerbindungen() {
  try {
    const r = await G.appRoot();
    const j = await G.readJson(r.driveId, r.id, VERBINDUNGEN_FILE);
    if (j.data && Array.isArray(j.data.betriebe)) {
      S.betriebe = j.data.betriebe.map((x) => {
        const lokal = S.betriebe.find((l) => l.itemId === x.itemId);
        return { ...x, key: lokal ? lokal.key : uuid() };
      });
      if (!aktiv()) S.active = S.betriebe[0] ? S.betriebe[0].key : null;
      speichereBetriebe();
    } else if (S.betriebe.length) {
      await speichereVerbindungen();
    }
  } catch (e) {
    console.warn("Verbindungen konnten nicht synchronisiert werden", e);
  }
}

async function speichereVerbindungen() {
  try {
    const r = await G.appRoot();
    await G.writeJson(r.driveId, r.id, VERBINDUNGEN_FILE, { betriebe: verbindungsDaten(), stand: new Date().toISOString() }, null);
  } catch (e) {
    console.warn("Verbindungen konnten nicht gespeichert werden", e);
  }
}

// --- Einladungslinks -----------------------------------------------------------
const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const unb64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
function einladungsLink(b, shareUrl) {
  const code = b64url(JSON.stringify({ d: b.driveId, i: b.itemId, n: b.name, s: shareUrl || undefined }));
  return `${REDIRECT_URI}?einladung=${code}`;
}

// Beim Öffnen eines Einladungslinks den Code merken (überlebt die Anmeldung)
(function merkeEinladung() {
  const p = new URLSearchParams(location.search);
  const code = p.get("einladung");
  if (code) {
    ls.set("sk_einladung", code);
    history.replaceState(null, "", location.pathname);
  }
})();

async function einladungAnnehmen() {
  const code = ls.get("sk_einladung", null);
  if (!code) return;
  let inv;
  try { inv = JSON.parse(unb64url(code)); } catch (_) {
    ls.set("sk_einladung", null);
    return toast("Der Einladungslink ist ungültig.", "fehler");
  }
  busy(`Verbinde „${inv.n}“ …`);
  try {
    let ziel = { driveId: inv.d, id: inv.i, name: inv.n };
    if (inv.s) {
      try { ziel = await G.resolveShareLink(inv.s); } catch (e) { console.warn(e); }
    }
    const cfg = await G.readJson(ziel.driveId, ziel.id, CONFIG_FILE);
    if (!cfg.data) throw new Error("Dieser Betrieb ist noch nicht eingerichtet. Bitte die Admin fragen.");
    let b = S.betriebe.find((x) => x.itemId === ziel.id);
    if (!b) {
      b = { key: uuid(), driveId: ziel.driveId, itemId: ziel.id, ordnerName: ziel.name, name: cfg.data.name, kurz: cfg.data.kurz, typ: cfg.data.typ };
      S.betriebe.push(b);
    }
    S.active = b.key;
    speichereBetriebe();
    await speichereVerbindungen();
    await ladeBetrieb(b, true);
    ls.set("sk_einladung", null);
    busy(null);
    closeModal();
    S.view = "erfassen";
    toast(`„${b.name}“ ist verbunden`);
    render();
  } catch (e) {
    busy(null);
    if ([401, 403, 404].includes(e.status)) zeigeEinladungHilfe(inv);
    else fehler(e);
  }
}

function zeigeEinladungHilfe(inv) {
  modal(`
    <div class="kopf"><h2>Noch kein Zugriff</h2></div>
    <p>Du wurdest für <b>„${esc(inv.n)}“</b> eingeladen, aber OneDrive hat den Zugriff noch nicht freigegeben.</p>
    <ol class="schritte">
      <li>Öffne die E-Mail von OneDrive („… hat einen Ordner mit Ihnen geteilt“) und tippe auf <b>Öffnen</b>.</li>
      <li>Melde dich dort mit demselben Microsoft-Konto an wie hier: <b>${esc(S.account.username)}</b></li>
      <li>Komm zurück und tippe auf <b>Erneut versuchen</b>.</li>
    </ol>
    <div class="aktionen">
      <button class="primary" data-act="einladung-retry">Erneut versuchen</button>
      <button class="sekundaer" data-act="einladung-abbrechen">Abbrechen</button>
    </div>`);
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
  const vl = await G.readJson(b.driveId, b.itemId, VORLAGEN_FILE).catch(() => ({ data: null, etag: null }));
  const d = {
    config: cfg.data || { name: b.name, kurz: b.kurz || b.name, typ: b.typ || "einzel", gesellschafter: [] },
    configEtag: cfg.etag,
    journal: jr.data || { version: 1, eintraege: [] },
    etag: jr.etag,
    vorlagen: (vl.data && vl.data.vorlagen) || [],
    vorlagenEtag: vl.etag,
  };
  S.data[b.key] = d;
  // Kategorien aus Version 1.1 einmalig umstellen
  if (jr.data && migriereKategorien({ eintraege: jr.data.eintraege.map((e) => ({ ...e })) })) {
    try {
      await updateJournal(b, (j) => { migriereKategorien(j); });
    } catch (e) { console.warn("Kategorien-Umstellung fehlgeschlagen", e); }
  }
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
      ${[["erfassen", "＋", "Erfassen"], ["journal", "☰", "Journal"], ["auswertung", "▤", "Auswertung"], ["einstellungen", "⚙︎", "Einstellungen"]]
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
  else if (S.view === "auswertung") renderAuswertung(main);
  else renderEinstellungen(main);
}

function renderLogin() {
  app.innerHTML = `
    <section class="login">
      <img src="icons/icon-512.png" alt="" class="logo">
      <h1>Schuhkarton Steuer</h1>
      <p>Belege fotografieren, ablegen und die EÜR vorbereiten.</p>
      ${ls.get("sk_einladung", null) ? `<p class="hinweis">Du wurdest eingeladen. Melde dich mit deinem Microsoft-Konto an – der Betrieb wird danach automatisch verbunden.</p>` : ""}
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
      <label class="${u("betrag")}"><span data-lbl="betrag">Betrag (€)</span><input name="betrag" inputmode="decimal" placeholder="0,00" value="${(v.gesamtCent || v.betragCent) ? betragText(v.gesamtCent || v.betragCent) : esc(v.betrag || "")}" required></label>
    </div>
    <div data-show="anteil" class="anteil">
      <label>Betrieblicher Anteil (%)<input name="anteil" inputmode="decimal" value="${esc(v.anteilProzent ?? v.anteil ?? 100)}"></label>
      <p class="klein" data-lbl="anteil"></p>
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
    <fieldset data-show="bewirtung" class="bewirtung">
      <legend>Angaben zur Bewirtung (Pflicht)</legend>
      <label>Anlass<input name="bewAnlass" value="${esc(v.bewAnlass || "")}" placeholder="z. B. Projektbesprechung Kooperation"></label>
      <label>Teilnehmende<input name="bewTeilnehmende" value="${esc(v.bewTeilnehmende || "")}" placeholder="Namen, inkl. dir selbst"></label>
      <label>Ort<input name="bewOrt" value="${esc(v.bewOrt || "")}" placeholder="Restaurant, Stadt"></label>
    </fieldset>
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
      anteil: art === "ausgabe" && !form.pauschaleTyp.value,
      bewirtung: art === "ausgabe" && form.kategorie.value === "Bewirtung",
    };
    form.querySelectorAll("[data-show]").forEach((el) => (el.style.display = show[el.dataset.show] ? "" : "none"));
    const lbl = form.querySelector('[data-lbl="partner"]');
    if (lbl) lbl.textContent = art === "einnahme" ? "Kunde / Zahlende:r" : "Lieferant / Empfänger:in";
    const anteilP = parseFloat(String(form.anteil.value).replace(",", "."));
    const teil = art === "ausgabe" && anteilP > 0 && anteilP < 100;
    form.querySelector('[data-lbl="betrag"]').textContent = teil ? "Rechnungsbetrag (€)" : "Betrag (€)";
    const gesamt = parseBetrag(form.betrag.value);
    form.querySelector('[data-lbl="anteil"]').textContent = teil && gesamt > 0 ? `Gebucht wird: ${euro(Math.round((gesamt * anteilP) / 100))} (${String(anteilP).replace(".", ",")} % von ${euro(gesamt)})` : "100 % = ganze Rechnung ist betrieblich";
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
      form.kategorie.value = "Fahrtkosten eigener Pkw";
    } else {
      form.betrag.value = betragText(Math.min(Math.round(n * HOMEOFFICE_TAG_CENT), HOMEOFFICE_MAX_CENT));
      form.kategorie.value = "Homeoffice-Pauschale";
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
  form.betrag.addEventListener("input", update);
  form.anteil.addEventListener("input", update);
  update();
}

function leseFormular(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  const art = f.art;
  const handel = art === "ausgabe" || art === "einnahme";
  const gesamtCent = parseBetrag(f.betrag);
  if (!f.belegdatum) throw new Error("Bitte ein Belegdatum angeben.");
  if (!(gesamtCent > 0)) throw new Error("Bitte einen gültigen Betrag angeben.");
  let anteilProzent = art === "ausgabe" && !f.pauschaleTyp ? parseFloat(String(f.anteil || "100").replace(",", ".")) : 100;
  if (!(anteilProzent > 0 && anteilProzent <= 100)) throw new Error("Der betriebliche Anteil muss zwischen 1 und 100 % liegen.");
  const betragCent = Math.round((gesamtCent * anteilProzent) / 100);
  const bewirtung = art === "ausgabe" && f.kategorie === "Bewirtung";
  if (bewirtung && (!f.bewAnlass.trim() || !f.bewTeilnehmende.trim() || !f.bewOrt.trim())) throw new Error("Bitte bei Bewirtungen Anlass, Teilnehmende und Ort angeben – das verlangt das Finanzamt.");
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
    gesamtCent: anteilProzent < 100 ? gesamtCent : null,
    anteilProzent: anteilProzent < 100 ? anteilProzent : null,
    bewAnlass: bewirtung ? f.bewAnlass.trim() : null,
    bewTeilnehmende: bewirtung ? f.bewTeilnehmende.trim() : null,
    bewOrt: bewirtung ? f.bewOrt.trim() : null,
  };
}

// Duplikat- und Anlagegut-Prüfung vor dem Speichern; false = abbrechen
function pruefeVorSpeichern(e, eigeneId) {
  const liste = aktivData().journal.eintraege.filter((x) => !x.storniert && x.id !== eigeneId);
  const norm = (s) => String(s || "").trim().toLowerCase();
  const dup = liste.find(
    (x) => (x.betragCent === e.betragCent && x.belegdatum === e.belegdatum && norm(x.partner) === norm(e.partner)) ||
      (e.rechnungsnr && norm(x.rechnungsnr) === norm(e.rechnungsnr) && norm(x.partner) === norm(e.partner)),
  );
  if (dup && !confirm(`Möglicherweise doppelt erfasst:\n${dup.belegnr} · ${datumDE(dup.belegdatum)} · ${dup.partner || ""} · ${euro(dup.betragCent)}\n\nTrotzdem speichern?`)) return false;
  const brutto = e.gesamtCent || e.betragCent;
  if (e.art === "ausgabe" && brutto > GWG_GRENZE_BRUTTO_CENT && e.kategorie !== "Software, Abos, Lizenzen" &&
    !confirm(`Betrag über ${euro(GWG_GRENZE_BRUTTO_CENT)} (≈ 800 € netto): Möglicherweise ein Anlagegut, das über mehrere Jahre abgeschrieben werden muss.\n\nComputer-Hardware und Software dürfen sofort voll abgesetzt werden.\n\nTrotzdem so speichern?`)) return false;
  return true;
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
  if (!pruefeVorSpeichern(e, null)) return;
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
  const r = ergebnis(d.journal, S.jahr);
  const offen = gueltig.filter((e) => e.status === "offen");
  const monate = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  const monNamen = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  const gbr = cfg.typ === "gbr" && (cfg.gesellschafter || []).filter((g) => g.name).length > 1;

  main.innerHTML = `
    <section class="card">
      <div class="kopf">
        <h2>Journal ${esc(cfg.name)}</h2>
        <select data-act="jahr">${jahre.map((j) => opt(j, j, S.jahr)).join("")}</select>
      </div>
      ${offen.length ? `<p class="hinweis gruen">${offen.length} offene${offen.length === 1 ? "r Posten" : " Posten"} (${euro(sum(offen))}) – zählt erst bei Zahlung.</p>` : ""}
      ${gbr ? "" : `<div class="summen">
        <div><small>+ Einnahmen</small><b>${euro(r.ein)}</b></div>
        <div><small>− Ausgaben</small><b>${euro(r.aus)}</b></div>
        <div><small>= Überschuss</small><b>${euro(r.ueberschuss)}</b></div>
      </div>
      <p class="klein">Summen nach Zahlungsdatum. Die EÜR mit allen Zeilen findest du unter „Auswertung“.</p>`}
    </section>
    ${gbr ? gbrUebersicht(d, cfg, r) : ""}
    <section class="card">
      <div class="filter">
        <select data-flt="monat">${opt("", "Alle Monate", f.monat)}${monate.map((m, i) => opt(m, monNamen[i], f.monat)).join("")}</select>
        <select data-flt="kat">${opt("", "Alle Kategorien", f.kat)}${[...KATEGORIEN_EINNAHME, ...KATEGORIEN_AUSGABE].map((k) => opt(k, k, f.kat)).join("")}</select>
        <input data-flt="q" placeholder="Suchen …" value="${esc(f.q)}">
      </div>
      ${liste.length ? `<ul class="liste">${liste.map(zeile).join("")}</ul>` : `<p class="leer">Keine Einträge.</p>`}
    </section>`;
}

function gbrUebersicht(d, cfg, r) {
  const ges = (cfg.gesellschafter || []).filter((g) => g.name);
  const ein = aufteilen(r.ein, ges);
  const aus = aufteilen(r.aus, ges);
  const ue = aufteilen(r.ueberschuss, ges);
  const g = gesellschafterUebersicht(d.journal, cfg, S.jahr);
  const kopf = `<tr><td></td>${ges.map((x) => `<th>${esc(vorname(x.name))}</th>`).join("")}</tr>`;
  const reihe = (label, werte, cls = "") => `<tr class="${cls}"><td>${label}</td>${werte.map((w) => `<td>${euro(w)}</td>`).join("")}</tr>`;
  const ausgeglichen = g.ausgeglichen;
  return `
    <section class="card">
      <h2>Ergebnis ${esc(S.jahr)}</h2>
      <div class="kennzahlen">
        <div><small>+ Einnahmen</small><b>${euro(r.ein)}</b></div>
        <div><small>− Ausgaben</small><b>${euro(r.aus)}</b></div>
        <div><small>= Überschuss</small><b>${euro(r.ueberschuss)}</b></div>
      </div>
      <table class="uebersicht">
        <tr><td class="klein">Aufteilung ${ges.map((x) => esc(String(x.anteil))).join("/")}</td>${ges.map((x) => `<th>${esc(vorname(x.name))}</th>`).join("")}</tr>
        ${reihe("+ Einnahmen", ein)}
        ${reihe("− Ausgaben", aus)}
        ${reihe("= Überschuss", ue, "summe")}
      </table>
    </section>
    <section class="card">
      <h2>Gesellschafterinnen</h2>
      <table class="uebersicht">
        ${kopf}
        ${g.hatVortrag ? reihe("Vortrag aus Vorjahren", g.personen.map((p) => p.vortrag)) : ""}
        ${reihe("+ Einlagen", g.personen.map((p) => p.einlagen))}
        ${reihe("− Entnahmen", g.personen.map((p) => p.entnahmen))}
        ${reihe("= Kapitalkonto", g.personen.map((p) => p.kapital), "summe")}
        <tr><td colspan="${ges.length + 1}" class="erl">${g.hatVortrag ? "Vortrag + " : ""}Überschussanteil + Einlagen − Entnahmen</td></tr>
      </table>
      <div class="ausgleich ${ausgeglichen ? "ok" : "neutral"}" data-act="ausgleich-info">
        ${ausgeglichen ? "✓ Kapitalkonten ausgeglichen" : `Die Kapitalkonten weichen um ${euro(g.differenz)} voneinander ab.`}
        ${ausgeglichen ? "" : `<div class="ausgleich-info" hidden>Ausgleichen lässt sich das durch eine Einlage der Gesellschafterin mit dem niedrigeren Stand oder eine Entnahme der Gesellschafterin mit dem höheren Stand. Ob und wann ihr ausgleicht, vereinbart ihr untereinander – steuerlich spielt es keine Rolle.</div>`}
      </div>
      <table class="uebersicht steuer">
        ${reihe("− Sonderbetriebs&shy;ausgaben", g.personen.map((p) => p.sba))}
        ${reihe("= Gewinnanteil (Steuer)", g.personen.map((p) => p.gewinnSteuer), "summe")}
        <tr><td colspan="${ges.length + 1}" class="erl">Anteil am steuerlichen Gewinn − Sonderbetriebsausgaben · für die Feststellungserklärung</td></tr>
      </table>
    </section>`;
}

const vorname = (name) => String(name || "").trim().split(/\s+/)[0];

function personKlasse(name) {
  const ges = ((aktivData() && aktivData().config.gesellschafter) || []).map((g) => g.name);
  const i = ges.indexOf(name);
  return i === 1 ? "p1" : "p0";
}

function zeile(e) {
  const minus = e.art === "ausgabe" || e.art === "entnahme";
  const titel = e.partner || (e.art === "einlage" ? `Einlage ${e.gesellschafterin}` : `Entnahme ${e.gesellschafterin}`);
  const badges = [];
  if (e.storniert) badges.push(`<i class="b rot">storniert</i>`);
  if (e.status === "offen") badges.push(`<i class="b">offen</i>`);
  if (e.eigenbeleg) badges.push(`<i class="b">Eigenbeleg</i>`);
  if (e.anteilProzent) badges.push(`<i class="b">${String(e.anteilProzent).replace(".", ",")} %</i>`);
  const pb = (txt, name) => badges.push(`<i class="b ${personKlasse(name)}">${esc(txt)} ${esc(name)}</i>`);
  if (e.behandlung === "einlage") pb("Einlage", e.bezahltVon);
  if (e.behandlung === "erstattung") pb("vorgestreckt", e.bezahltVon);
  if (e.behandlung === "sonderbetriebsausgabe") pb("SBA", e.bezahltVon);
  if (e.art === "einlage") pb("Einlage", e.gesellschafterin);
  if (e.art === "entnahme") pb(e.entnahmeArt === "erstattung" ? "Erstattung" : "Entnahme", e.gesellschafterin);
  return `<li data-act="detail" data-id="${e.id}" class="${e.storniert ? "storno" : ""}">
    <div class="l1"><span>${esc(titel)}</span><b><i class="punkt ${minus ? "aus" : "ein"}"></i>${minus ? "−" : "+"}${euro(e.betragCent)}</b></div>
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
      ${reihe("Betrag", euro(e.betragCent) + (e.anteilProzent ? `<br><small>${String(e.anteilProzent).replace(".", ",")} % von ${euro(e.gesamtCent)}</small>` : ""))}
      ${reihe("Belegdatum", datumDE(e.belegdatum))}
      ${reihe("Status", e.status === "bezahlt" ? `bezahlt am ${datumDE(e.zahlungsdatum)}` : "offen")}
      ${reihe(e.art === "einnahme" ? "Kunde" : "Lieferant", esc(e.partner))}
      ${reihe("Gesellschafterin", esc(e.gesellschafterin))}
      ${reihe("Kategorie", esc(e.kategorie))}
      ${reihe("Beschreibung", esc(e.beschreibung))}
      ${e.bewAnlass ? reihe("Bewirtung", `Anlass: ${esc(e.bewAnlass)}<br>Teilnehmende: ${esc(e.bewTeilnehmende)}<br>Ort: ${esc(e.bewOrt)}`) : ""}
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
  if (!pruefeVorSpeichern(neu, id)) return;
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
// Auswertung (EÜR)
// ---------------------------------------------------------------------------
function jahreListe(d) {
  return [...new Set([String(new Date().getFullYear()), ...d.journal.eintraege.map(zahlJahr)])].filter(Boolean).sort().reverse();
}

function pruefhinweise(d, eu) {
  const j = S.jahr;
  const hin = [];
  const im = d.journal.eintraege.filter((e) => !e.storniert);
  const offen = im.filter((e) => e.status === "offen" && (e.belegdatum || "").startsWith(j));
  if (offen.length) hin.push(["warn", `${offen.length} offene${offen.length === 1 ? "r Posten" : " Posten"} aus ${j} (${euro(offen.reduce((s, e) => s + e.betragCent, 0))}) – zählen erst, wenn sie bezahlt sind.`]);
  const bew = im.filter((e) => e.kategorie === "Bewirtung" && zahlJahr(e) === j && !(e.bewAnlass && e.bewTeilnehmende));
  if (bew.length) hin.push(["warn", `${bew.length} Bewirtung${bew.length === 1 ? "" : "en"} ohne Anlass oder Teilnehmende – ohne diese Angaben erkennt das Finanzamt den Abzug nicht an.`]);
  const ho = eu.zeilen.find((z) => z.id === "ho");
  if (ho && ho.brutto > HOMEOFFICE_MAX_CENT) hin.push(["fehler", `Homeoffice-Pauschale ${euro(ho.brutto)} – höchstens ${euro(HOMEOFFICE_MAX_CENT)} im Jahr sind abziehbar.`]);
  if (d.config.kleinunternehmer !== false) {
    const vorjahr = euer(d.journal, String(Number(j) - 1)).be;
    if (eu.be > KU_GRENZE_LAUFEND_CENT) hin.push(["fehler", `Einnahmen über ${euro(KU_GRENZE_LAUFEND_CENT)} – die Kleinunternehmerregelung entfällt ab dem Umsatz, der die Grenze überschreitet. Bitte steuerlich beraten lassen.`]);
    else if (eu.be > KU_GRENZE_VORJAHR_CENT) hin.push(["warn", `Einnahmen ${j} über ${euro(KU_GRENZE_VORJAHR_CENT)} – ab ${Number(j) + 1} gilt die Kleinunternehmerregelung voraussichtlich nicht mehr.`]);
    else if (eu.be > KU_GRENZE_VORJAHR_CENT * 0.8) hin.push(["info", `Einnahmen ${euro(eu.be)} – nahe an der Kleinunternehmer-Grenze von ${euro(KU_GRENZE_VORJAHR_CENT)}.`]);
    if (vorjahr > KU_GRENZE_VORJAHR_CENT) hin.push(["warn", `Einnahmen ${Number(j) - 1} lagen über ${euro(KU_GRENZE_VORJAHR_CENT)} – Kleinunternehmerregelung für ${j} prüfen.`]);
  }
  if (eu.ohneZuordnung.length) hin.push(["warn", `${eu.ohneZuordnung.length} Buchung${eu.ohneZuordnung.length === 1 ? "" : "en"} ohne gültige Kategorie – bitte im Journal bearbeiten.`]);
  return hin;
}

function renderAuswertung(main) {
  const d = aktivData();
  const cfg = d.config;
  const eu = euer(d.journal, S.jahr);
  const hin = pruefhinweise(d, eu);
  const gbr = cfg.typ === "gbr" && (cfg.gesellschafter || []).filter((g) => g.name).length > 1;
  const g = gbr ? gesellschafterUebersicht(d.journal, cfg, S.jahr) : null;
  const zeileHtml = (z) => `<tr data-act="euer-zeile" data-id="${z.id}" class="klick">
      <td class="z">${esc(z.zeile || "–")}</td>
      <td>${esc(z.bez)}${z.nichtAbziehbar ? `<br><small>gesamt ${euro(z.brutto)}, davon nicht abziehbar ${euro(z.nichtAbziehbar)}</small>` : ""}</td>
      <td class="bt">${euro(z.betrag)}</td></tr>`;
  const ein = eu.zeilen.filter((z) => z.typ === "einnahme" && z.brutto);
  const aus = eu.zeilen.filter((z) => z.typ === "ausgabe" && z.brutto);
  main.innerHTML = `
    <section class="card">
      <div class="kopf"><h2>EÜR ${esc(cfg.name)}</h2><select data-act="jahr">${jahreListe(d).map((j) => opt(j, j, S.jahr)).join("")}</select></div>
      ${hin.length ? hin.map(([t, txt]) => `<p class="hinweis ${t === "fehler" ? "rotf" : t === "info" ? "gruen" : "neutral"}">${esc(txt)}</p>`).join("") : `<p class="hinweis gruen">✓ Keine Auffälligkeiten für ${esc(S.jahr)}</p>`}
    </section>
    <section class="card">
      <table class="euer">
        <tr><th class="z">Zeile</th><th>Betriebseinnahmen</th><th class="bt">Betrag</th></tr>
        ${ein.map(zeileHtml).join("") || `<tr><td></td><td class="leer">Keine Einnahmen</td><td></td></tr>`}
        <tr class="summe"><td class="z">23</td><td>Summe Betriebseinnahmen</td><td class="bt">${euro(eu.be)}</td></tr>
        <tr><th class="z">Zeile</th><th>Betriebsausgaben</th><th class="bt"></th></tr>
        ${aus.map(zeileHtml).join("") || `<tr><td></td><td class="leer">Keine Ausgaben</td><td></td></tr>`}
        <tr class="summe"><td class="z"></td><td>Summe Betriebsausgaben</td><td class="bt">${euro(eu.ba)}</td></tr>
        <tr class="gewinn"><td class="z"></td><td>${eu.gewinn >= 0 ? "Gewinn" : "Verlust"}</td><td class="bt">${euro(eu.gewinn)}</td></tr>
      </table>
      <p class="klein">Zeile antippen zeigt die Buchungen. Zeilennummern laut Vordruck 2026, soweit eindeutig belegt – maßgeblich ist die Bezeichnung im Steuerprogramm.${gbr ? " Sonderbetriebsausgaben sind hier nicht enthalten, sie gehören zur jeweiligen Gesellschafterin." : ""}</p>
    </section>
    ${gbr ? `<section class="card">
      <h2>Für die Feststellungserklärung</h2>
      <table class="uebersicht">
        <tr><td></td>${g.personen.map((p) => `<th>${esc(vorname(p.name))}</th>`).join("")}</tr>
        <tr><td>Anteil am Gewinn</td>${g.personen.map((p) => `<td>${euro(p.gewinnSteuer + p.sba)}</td>`).join("")}</tr>
        <tr><td>− Sonderbetriebs&shy;ausgaben</td>${g.personen.map((p) => `<td>${euro(p.sba)}</td>`).join("")}</tr>
        <tr class="summe"><td>= Gewinnanteil</td>${g.personen.map((p) => `<td>${euro(p.gewinnSteuer)}</td>`).join("")}</tr>
        <tr><td colspan="${g.personen.length + 1}" class="erl">Informativ, ohne steuerliche Wirkung:</td></tr>
        <tr><td>Einlagen</td>${g.personen.map((p) => `<td>${euro(p.einlagen)}</td>`).join("")}</tr>
        <tr><td>Entnahmen</td>${g.personen.map((p) => `<td>${euro(p.entnahmen)}</td>`).join("")}</tr>
      </table>
    </section>` : ""}
    <section class="card">
      <button class="primary big" data-act="euer-pdf">PDF „EÜR ${esc(S.jahr)}“ erstellen</button>
      <p class="klein">Das PDF wird im Betriebsordner unter „Auswertungen“ abgelegt und enthält die EÜR${gbr ? ", die Werte für die Feststellungserklärung" : ""} und die Belegliste.</p>
    </section>`;
}

function zeigeEuerZeile(id) {
  const eu = euer(aktivData().journal, S.jahr);
  const z = eu.zeilen.find((x) => x.id === id);
  if (!z) return;
  modal(`
    <div class="kopf"><h2>${esc(z.zeile ? "Zeile " + z.zeile : z.bez)}</h2><button class="link" data-act="modal-zu">Schließen</button></div>
    <p>${esc(z.bez)} · ${euro(z.brutto)}${z.nichtAbziehbar ? ` (abziehbar ${euro(z.betrag)})` : ""}</p>
    <ul class="liste">${z.eintraege.map(zeile).join("")}</ul>`);
}

async function euerExport() {
  const b = aktiv();
  const d = aktivData();
  const cfg = d.config;
  const gbr = cfg.typ === "gbr" && (cfg.gesellschafter || []).filter((g) => g.name).length > 1;
  busy("Erstelle PDF …");
  try {
    const eu = euer(d.journal, S.jahr);
    const eintraege = d.journal.eintraege
      .filter((e) => !e.storniert && e.status === "bezahlt" && zahlJahr(e) === S.jahr)
      .sort((a, b2) => (a.belegnr || "").localeCompare(b2.belegnr || ""));
    const blob = euerPdf({ config: cfg, jahr: S.jahr, eu, gesellschaft: gbr ? gesellschafterUebersicht(d.journal, cfg, S.jahr) : null, eintraege, ersteller: ichBin() });
    busy("Lege PDF in OneDrive ab …");
    const ordner = await G.ensurePath(b.driveId, b.itemId, ["Auswertungen"]);
    const name = `EUER_${S.jahr}_${cfg.kurz}.pdf`;
    const item = await G.uploadFile(b.driveId, ordner, name, blob, { overwrite: true });
    busy(null);
    const datei = new File([blob], name, { type: "application/pdf" });
    const teilbar = navigator.canShare && navigator.canShare({ files: [datei] });
    modal(`
      <div class="kopf"><h2>PDF erstellt</h2><button class="link" data-act="modal-zu">Fertig</button></div>
      <p>„${esc(name)}“ liegt im Betriebsordner unter „Auswertungen“.</p>
      <div class="aktionen">
        ${item && item.webUrl ? `<a class="primary btn" href="${esc(item.webUrl)}" target="_blank" rel="noopener">PDF öffnen</a>` : ""}
        ${teilbar ? `<button class="sekundaer" data-act="pdf-teilen">Teilen …</button>` : ""}
      </div>`);
    S.letztesPdf = datei;
  } catch (e) { fehler(e); }
}

// ---------------------------------------------------------------------------
// Wiederkehrende Buchungen
// ---------------------------------------------------------------------------
const RHYTHMUS = { monatlich: "monatlich", vierteljaehrlich: "vierteljährlich", jaehrlich: "jährlich" };
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const periodeText = (p) => `${MONATE[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;

async function updateVorlagen(b, mutate) {
  for (let i = 0; i < 4; i++) {
    const jr = await G.readJson(b.driveId, b.itemId, VORLAGEN_FILE);
    const data = jr.data || { version: 1, vorlagen: [] };
    const res = mutate(data);
    try {
      const item = await G.writeJson(b.driveId, b.itemId, VORLAGEN_FILE, data, jr.etag);
      S.data[b.key].vorlagen = data.vorlagen;
      S.data[b.key].vorlagenEtag = item && item.eTag;
      return res;
    } catch (e) {
      if (e.status === 412) continue;
      throw e;
    }
  }
  throw new Error("Die Vorlagen wurden gleichzeitig geändert. Bitte noch einmal speichern.");
}

function zeigeVorlagen(b) {
  const d = S.data[b.key];
  const liste = d.vorlagen || [];
  modal(`
    <div class="kopf"><h2>Wiederkehrende Buchungen</h2><button class="link" data-act="modal-zu">Schließen</button></div>
    <p class="klein">Für Anteile aus privaten Rechnungen, z. B. Handy oder Internet. Die App fragt beim Öffnen nach, bevor sie fällige Buchungen anlegt.</p>
    ${liste.length ? `<ul class="betriebe">${liste.map((v) => {
      const f = faelligePerioden(v, heute());
      return `<li><div><b>${esc(v.bezeichnung)}</b>
        <small>${euro(Math.round((v.gesamtCent * v.anteil) / 100))} ${RHYTHMUS[v.rhythmus]} (${String(v.anteil).replace(".", ",")} % von ${euro(v.gesamtCent)}) · ${esc(v.kategorie)}${v.behandlung === "sonderbetriebsausgabe" ? ` · SBA ${esc(v.bezahltVon)}` : ""}</small>
        <small>ab ${periodeText(v.start)}${v.ende ? ` bis ${periodeText(v.ende)}` : ""}${f.length ? ` · ${f.length} fällig` : ""}</small></div>
        <div class="knoepfe"><button class="link" data-act="vorlage-edit" data-key="${b.key}" data-id="${v.id}">Bearbeiten</button>
        <button class="link rot" data-act="vorlage-weg" data-key="${b.key}" data-id="${v.id}">Löschen</button></div></li>`;
    }).join("")}</ul>` : `<p class="leer">Noch keine Vorlagen.</p>`}
    <div class="aktionen"><button class="primary" data-act="vorlage-neu" data-key="${b.key}">＋ Neue Vorlage</button>
    ${liste.some((v) => faelligePerioden(v, heute()).length) ? `<button class="sekundaer" data-act="faellige" data-key="${b.key}">Fällige jetzt prüfen</button>` : ""}</div>`);
}

function zeigeVorlageForm(b, id) {
  const d = S.data[b.key];
  const cfg = d.config;
  const gbr = cfg.typ === "gbr";
  const ges = (cfg.gesellschafter || []).map((g) => g.name).filter(Boolean);
  const v = (d.vorlagen || []).find((x) => x.id === id) || { rhythmus: "monatlich", start: heute().slice(0, 7), tag: 1, anteil: 100, kategorie: "Telefon, Internet (anteilig)", bezahltVon: gbr ? ges[0] : null, behandlung: gbr ? "sonderbetriebsausgabe" : null };
  modal(`
    <div class="kopf"><h2>${id ? "Vorlage bearbeiten" : "Neue Vorlage"}</h2><button class="link" data-act="vorlagen" data-key="${b.key}">Zurück</button></div>
    <form id="vorlageform">
      <label>Bezeichnung<input name="bezeichnung" value="${esc(v.bezeichnung || "")}" placeholder="z. B. Handy betrieblicher Anteil" required></label>
      <label>Anbieter<input name="partner" value="${esc(v.partner || "")}" placeholder="z. B. Telekom" required></label>
      <label>Kategorie<select name="kategorie">${KATEGORIEN_AUSGABE.map((k) => opt(k, k, v.kategorie)).join("")}</select></label>
      <div class="zwei">
        <label>Rechnungsbetrag (€)<input name="gesamt" inputmode="decimal" value="${v.gesamtCent ? betragText(v.gesamtCent) : ""}" required></label>
        <label>Betrieblicher Anteil (%)<input name="anteil" inputmode="decimal" value="${esc(v.anteil)}" required></label>
      </div>
      <div class="zwei">
        <label>Rhythmus<select name="rhythmus">${Object.entries(RHYTHMUS).map(([k, l]) => opt(k, l, v.rhythmus)).join("")}</select></label>
        <label>Buchungstag im Monat<input name="tag" type="number" min="1" max="28" value="${esc(v.tag)}"></label>
      </div>
      <div class="zwei">
        <label>Ab (Monat)<input name="start" type="month" value="${esc(v.start)}" required></label>
        <label>Bis (optional)<input name="ende" type="month" value="${esc(v.ende || "")}"></label>
      </div>
      ${gbr ? `<label>Bezahlt von<select name="bezahltVon">${opt("betrieb", "GbR-Konto", v.bezahltVon || "betrieb")}${ges.map((n) => opt(n, `${n} privat`, v.bezahltVon)).join("")}</select></label>
      <label>Behandlung<select name="behandlung">${opt("sonderbetriebsausgabe", "Sonderbetriebsausgabe (trägt sie allein)", v.behandlung)}${opt("einlage", "Einlage", v.behandlung)}${opt("erstattung", "Wird vom GbR-Konto erstattet", v.behandlung)}</select></label>` : ""}
      <p class="klein">Jede fällige Buchung bekommt automatisch einen Eigenbeleg. Hast du die private Rechnung, kannst du sie zusätzlich im Betriebsordner ablegen.</p>
      <div class="aktionen"><button type="submit" class="primary big">Speichern</button></div>
    </form>`);
  modalEl.querySelector("#vorlageform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target).entries());
    const gesamtCent = parseBetrag(f.gesamt);
    const anteil = parseFloat(String(f.anteil).replace(",", "."));
    if (!(gesamtCent > 0)) return toast("Bitte einen gültigen Betrag angeben.", "fehler");
    if (!(anteil > 0 && anteil <= 100)) return toast("Der Anteil muss zwischen 1 und 100 % liegen.", "fehler");
    if (f.ende && f.ende < f.start) return toast("„Bis“ liegt vor „Ab“.", "fehler");
    const neu = {
      id: id || uuid(), bezeichnung: f.bezeichnung.trim(), partner: f.partner.trim(), kategorie: f.kategorie,
      gesamtCent, anteil, rhythmus: f.rhythmus, tag: Math.min(28, Math.max(1, parseInt(f.tag, 10) || 1)),
      start: f.start, ende: f.ende || null,
      bezahltVon: gbr ? f.bezahltVon : null,
      behandlung: gbr && f.bezahltVon !== "betrieb" ? f.behandlung : null,
    };
    busy("Speichere Vorlage …");
    try {
      await updateVorlagen(b, (data) => {
        const alt = data.vorlagen.find((x) => x.id === neu.id);
        if (alt) Object.assign(alt, neu, { erledigt: alt.erledigt || [] });
        else data.vorlagen.push({ ...neu, erledigt: [], angelegtVon: ichBin(), angelegtAm: new Date().toISOString() });
      });
      busy(null);
      toast("Vorlage gespeichert");
      zeigeVorlagen(b);
    } catch (e) { fehler(e); }
  });
}

function faelligeListe(b) {
  const d = S.data[b.key];
  return (d.vorlagen || []).flatMap((v) => faelligePerioden(v, heute()).map((p) => ({ v, p })));
}

function zeigeFaellige(b) {
  const f = faelligeListe(b);
  if (!f.length) { closeModal(); return toast("Keine fälligen Buchungen."); }
  modal(`
    <div class="kopf"><h2>${f.length} Buchung${f.length === 1 ? "" : "en"} fällig</h2><button class="link" data-act="modal-zu">Später</button></div>
    <p class="klein">${esc(S.data[b.key].config.name)} · Wiederkehrende Buchungen</p>
    <form id="faelligform">
      <ul class="faellig">${f.map((x, i) => `<li><label class="check"><input type="checkbox" name="f${i}" checked>
        <span><b>${esc(x.v.bezeichnung)}</b> · ${periodeText(x.p)}<br><small>${euro(Math.round((x.v.gesamtCent * x.v.anteil) / 100))}${x.v.behandlung === "sonderbetriebsausgabe" ? ` · SBA ${esc(x.v.bezahltVon)}` : ""}</small></span></label></li>`).join("")}</ul>
      <div class="aktionen">
        <button type="submit" class="primary" name="aktion" value="anlegen">Ausgewählte anlegen</button>
        <button type="submit" class="sekundaer" name="aktion" value="ueberspringen">Ausgewählte überspringen</button>
      </div>
    </form>`);
  modalEl.querySelector("#faelligform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const aktion = ev.submitter && ev.submitter.value;
    const gewaehlt = f.filter((_, i) => ev.target[`f${i}`].checked);
    if (!gewaehlt.length) return toast("Nichts ausgewählt.", "fehler");
    if (aktion === "ueberspringen" && !confirm(`${gewaehlt.length} Buchung(en) überspringen? Sie werden danach nicht mehr vorgeschlagen.`)) return;
    try {
      if (aktion === "anlegen") await faelligeAnlegen(b, gewaehlt);
      await updateVorlagen(b, (data) => {
        for (const x of gewaehlt) {
          const v = data.vorlagen.find((y) => y.id === x.v.id);
          if (v) v.erledigt = [...new Set([...(v.erledigt || []), x.p])];
        }
      });
      busy(null);
      closeModal();
      toast(aktion === "anlegen" ? `${gewaehlt.length} Buchung(en) angelegt` : "Übersprungen");
      render();
    } catch (e) { fehler(e); }
  });
}

async function faelligeAnlegen(b, liste) {
  const d = S.data[b.key];
  let n = 0;
  for (const { v, p } of liste) {
    n++;
    busy(`Lege Buchung ${n} von ${liste.length} an …`);
    const datum = `${p}-${String(v.tag || 1).padStart(2, "0")}`;
    const e = {
      id: uuid(), art: "ausgabe", belegdatum: datum, zahlungsdatum: datum, status: "bezahlt",
      betragCent: Math.round((v.gesamtCent * v.anteil) / 100),
      gesamtCent: v.anteil < 100 ? v.gesamtCent : null, anteilProzent: v.anteil < 100 ? v.anteil : null,
      partner: v.partner, kategorie: v.kategorie, beschreibung: `${v.bezeichnung} ${periodeText(p)}`, rechnungsnr: "",
      bezahltVon: v.bezahltVon, behandlung: v.behandlung, gesellschafterin: "", entnahmeArt: null,
      eigenbeleg: true, eigenbelegGrund: "Wiederkehrende Buchung (Anteil aus privater Rechnung)", pauschale: null,
      vorlageId: v.id, periode: p, erfasstVon: ichBin(), erfasstAm: new Date().toISOString(), storniert: false, historie: [],
    };
    const jahr = datum.slice(0, 4);
    e.belegnr = naechsteBelegnr(d.journal, jahr);
    const blob = eigenbelegPdf(e, d.config, ichBin());
    const ordner = await G.ensurePath(b.driveId, b.itemId, [BELEGE_FOLDER, jahr]);
    const item = await G.uploadFile(b.driveId, ordner, dateiname(e, d.config.kurz), blob);
    e.datei = { id: item.id, name: item.name, webUrl: item.webUrl, driveId: b.driveId };
    await updateJournal(b, (j) => {
      if (j.eintraege.some((x) => x.vorlageId === v.id && x.periode === p && !x.storniert)) return; // schon angelegt
      if (j.eintraege.some((x) => x.belegnr === e.belegnr)) e.belegnr = naechsteBelegnr(j, jahr);
      j.eintraege.push(e);
    });
  }
  busy("Aktualisiere Excel-Kopie …");
  await excelSpiegeln(b);
}

const faelligGeprueft = new Set();
function pruefeFaelligBeimOeffnen() {
  const b = aktiv();
  if (!b || faelligGeprueft.has(b.key) || !S.data[b.key]) return;
  faelligGeprueft.add(b.key);
  if (faelligeListe(b).length) zeigeFaellige(b);
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
      ${S.betriebe.length ? `<ul class="betriebe">${S.betriebe.map((b) => {
        const cfg = cfgVon(b);
        const admin = istAdmin(cfg);
        const ohneAdmins = cfg && (!Array.isArray(cfg.admins) || !cfg.admins.length);
        return `
        <li><div><b>${esc(b.name)}</b><small>${b.typ === "gbr" ? "GbR" : "Einzelunternehmen"} · Rolle: ${admin ? "Admin" : "Erfassen"}</small>
          ${ohneAdmins ? `<small class="warnung">Noch keine Admins festgelegt – bitte unter „Betriebsdaten“ eintragen.</small>` : ""}</div>
          <div class="knoepfe">
          ${admin ? `<button class="link" data-act="cfg" data-key="${b.key}">Betriebsdaten</button>
          <button class="link" data-act="personen" data-key="${b.key}">Personen freischalten</button>` : ""}
          <button class="link" data-act="vorlagen" data-key="${b.key}">Wiederkehrende Buchungen</button>
          <button class="link rot" data-act="trennen" data-key="${b.key}">Trennen</button></div></li>`;
      }).join("")}</ul>`
        : `<p>Noch kein Betrieb verbunden.</p>`}
      <button class="primary" data-act="verbinden">＋ Betriebsordner verbinden</button>
      <p class="klein">Verbundene Betriebe werden in deinem OneDrive gemerkt und erscheinen auf allen deinen Geräten. „Trennen“ entfernt nur deine Verbindung – die Daten des Betriebs bleiben unverändert.</p>
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
      await speichereVerbindungen();
      await ladeBetrieb(b, true);
      toast(`„${b.name}“ verbunden`);
      S.view = "erfassen";
      render();
    } else {
      // Neue Betriebe nur in einem Ordner im eigenen OneDrive anlegen (Besitzerin = erste Admin)
      const mein = await G.myDrive();
      if (mein.id !== top.driveId) {
        modal(`<div class="kopf"><h2>Noch nicht eingerichtet</h2><button class="link" data-act="modal-zu">Schließen</button></div>
          <p>Für den Ordner „${esc(top.name)}“ gibt es noch keine Betriebsdaten. Sie werden von einer Admin angelegt. Bitte melde dich bei ihr – danach kannst du den Ordner hier verbinden.</p>`);
        return;
      }
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
    admins: [meineMail()],
  };
  const ges = c.gesellschafter && c.gesellschafter.length ? c.gesellschafter : [{ name: "", anteil: 50 }, { name: "", anteil: 50 }];
  const admins = Array.isArray(c.admins) && c.admins.length ? c.admins : [meineMail()];
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
      <label>Admins (Microsoft-Konto, eine E-Mail-Adresse pro Zeile)
        <textarea name="admins" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(admins.join("\n"))}</textarea></label>
      <p class="klein">Admins dürfen Betriebsdaten ändern und Personen freischalten. Alle anderen mit Zugriff können Belege erfassen und das Journal sehen.</p>
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
      admins: [...new Set(String(f.admins || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes("@")))],
      geaendertVon: ichBin(),
      geaendertAm: new Date().toISOString(),
    };
    if (!cfg.admins.length) return toast("Bitte mindestens eine Admin-Adresse eintragen.", "fehler");
    if (!cfg.admins.includes(meineMail()) && !confirm("Deine eigene Adresse steht nicht in der Admin-Liste. Du kannst die Betriebsdaten danach nicht mehr ändern. Trotzdem speichern?")) return;
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
      await speichereVerbindungen();
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
// Personen freischalten (nur Admins)
// ---------------------------------------------------------------------------
function personAus(p) {
  const u = (p.grantedToV2 && p.grantedToV2.user) || (p.grantedTo && p.grantedTo.user) || null;
  const ids = (p.grantedToIdentitiesV2 || p.grantedToIdentities || []).map((x) => x.user).filter(Boolean);
  const name = (u && (u.displayName || u.email)) || ids.map((x) => x.displayName || x.email).join(", ") || (p.invitation && p.invitation.email) || "";
  const email = (u && u.email) || (ids[0] && ids[0].email) || (p.invitation && p.invitation.email) || "";
  return { name, email };
}

async function zeigePersonen(b) {
  busy("Lade Freigaben …");
  let perms = [];
  try { perms = await G.listPermissions(b.driveId, b.itemId); } catch (e) { busy(null); return fehler(e); }
  busy(null);
  const cfg = cfgVon(b);
  const admins = (cfg && cfg.admins) || [];
  const zeilen = perms.map((p) => {
    const roles = p.roles || [];
    const { name, email } = personAus(p);
    if (roles.includes("owner")) return `<li><div><b>${esc(name || "Besitzerin")}</b><small>Besitzerin</small></div></li>`;
    if (p.link && !name) return `<li><div><b>Freigabelink</b><small>${esc(p.link.scope || "")} · ${roles.includes("write") ? "bearbeiten" : "ansehen"}</small></div>
      ${p.inheritedFrom ? "" : `<button class="link rot" data-act="perm-weg" data-id="${esc(p.id)}" data-key="${b.key}">Entfernen</button>`}</li>`;
    const istAdm = email && admins.includes(email.toLowerCase());
    return `<li><div><b>${esc(name || email || "Unbekannt")}</b><small>${roles.includes("write") ? "darf erfassen" : "nur ansehen"}${istAdm ? " · Admin" : ""}${p.inheritedFrom ? " · über übergeordneten Ordner" : ""}</small></div>
      ${p.inheritedFrom ? "" : `<button class="link rot" data-act="perm-weg" data-id="${esc(p.id)}" data-key="${b.key}">Entfernen</button>`}</li>`;
  });
  modal(`
    <div class="kopf"><h2>Personen · ${esc(b.name)}</h2><button class="link" data-act="modal-zu">Schließen</button></div>
    <h3>Zugriff haben</h3>
    <ul class="betriebe">${zeilen.join("") || `<li class="leer">Noch niemand freigeschaltet</li>`}</ul>
    <h3>Person freischalten</h3>
    <form id="einladen">
      <label>E-Mail-Adresse ihres Microsoft-Kontos<input name="email" type="email" required autocapitalize="off" placeholder="name@beispiel.de"></label>
      <div class="aktionen"><button type="submit" class="primary">Freischalten und Einladung erstellen</button></div>
    </form>
    <p class="klein">OneDrive schickt der Person eine E-Mail. Zusätzlich bekommst du einen Einladungslink für die App, den du ihr schickst.</p>
    <button class="link" data-act="nur-link" data-key="${b.key}">Nur Einladungslink erzeugen (für Personen, die schon Zugriff haben)</button>`);
  modalEl.querySelector("#einladen").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = ev.target.email.value.trim();
    busy("Schalte frei …");
    try {
      const res = await G.invite(b.driveId, b.itemId, email, `Du wurdest für „${b.name}“ in der App Schuhkarton Steuer freigeschaltet.`);
      const p = res && res.value && res.value[0];
      const shareUrl = p && p.link && p.link.webUrl;
      busy(null);
      zeigeEinladungslink(b, einladungsLink(b, shareUrl), email);
    } catch (e) { fehler(e); }
  });
}

function zeigeEinladungslink(b, link, email) {
  const text = `Hallo! Ich habe dich für „${b.name}“ in unserer Beleg-App „Schuhkarton Steuer“ freigeschaltet.\n\n1. Öffne die E-Mail von OneDrive und tippe auf „Öffnen“ (mit deinem Microsoft-Konto anmelden).\n2. Öffne dann diesen Link und melde dich an:\n${link}\n\nTipp: Auf dem Handy die App danach über „Zum Home-Bildschirm“ hinzufügen.`;
  modal(`
    <div class="kopf"><h2>Einladung</h2><button class="link" data-act="modal-zu">Fertig</button></div>
    ${email ? `<p>✓ <b>${esc(email)}</b> hat jetzt Zugriff auf „${esc(b.name)}“ und bekommt eine E-Mail von OneDrive.</p>` : ""}
    <p>Schick ihr zusätzlich diese Nachricht:</p>
    <textarea id="einladungstext" rows="9" readonly>${esc(text)}</textarea>
    <div class="aktionen">
      <button class="primary" data-act="text-kopieren">Text kopieren</button>
      ${navigator.share ? `<button class="sekundaer" data-act="text-teilen">Teilen …</button>` : ""}
    </div>`);
}

async function entfernePerm(b, permId) {
  if (!confirm("Zugriff dieser Person auf den Ordner entfernen? Sie kann den Betrieb dann nicht mehr öffnen.")) return;
  busy("Entferne Freigabe …");
  await G.deletePermission(b.driveId, b.itemId, permId);
  busy(null);
  toast("Freigabe entfernt");
  await zeigePersonen(b);
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
        busy("Lade …"); await ladeBetrieb(aktiv(), true); busy(null); render(); pruefeFaelligBeimOeffnen(); break;
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
        speichereBetriebe(); await speichereVerbindungen(); render(); break;
      }
      case "personen": await zeigePersonen(S.betriebe.find((x) => x.key === el.dataset.key)); break;
      case "ausgleich-info": { const i = el.querySelector(".ausgleich-info"); if (i) i.hidden = !i.hidden; break; }
      case "euer-zeile": zeigeEuerZeile(el.dataset.id); break;
      case "euer-pdf": await euerExport(); break;
      case "pdf-teilen": try { await navigator.share({ files: [S.letztesPdf], title: S.letztesPdf.name }); } catch (_) {} break;
      case "vorlagen": { const b = S.betriebe.find((x) => x.key === el.dataset.key); busy("Lade …"); await ladeBetrieb(b, true); busy(null); zeigeVorlagen(b); break; }
      case "vorlage-neu": zeigeVorlageForm(S.betriebe.find((x) => x.key === el.dataset.key), null); break;
      case "vorlage-edit": zeigeVorlageForm(S.betriebe.find((x) => x.key === el.dataset.key), el.dataset.id); break;
      case "vorlage-weg": {
        const b = S.betriebe.find((x) => x.key === el.dataset.key);
        if (!confirm("Vorlage löschen? Bereits angelegte Buchungen bleiben erhalten.")) return;
        busy("Lösche …");
        await updateVorlagen(b, (data) => { data.vorlagen = data.vorlagen.filter((v) => v.id !== el.dataset.id); });
        busy(null); zeigeVorlagen(b); break;
      }
      case "faellige": zeigeFaellige(S.betriebe.find((x) => x.key === el.dataset.key)); break;
      case "perm-weg": await entfernePerm(S.betriebe.find((x) => x.key === el.dataset.key), el.dataset.id); break;
      case "nur-link": {
        const b = S.betriebe.find((x) => x.key === el.dataset.key);
        zeigeEinladungslink(b, einladungsLink(b), null); break;
      }
      case "text-kopieren": {
        const t = document.getElementById("einladungstext");
        try { await navigator.clipboard.writeText(t.value); } catch (_) { t.select(); document.execCommand("copy"); }
        toast("Text kopiert"); break;
      }
      case "text-teilen":
        try { await navigator.share({ text: document.getElementById("einladungstext").value }); } catch (_) {}
        break;
      case "einladung-retry": closeModal(); await einladungAnnehmen(); break;
      case "einladung-abbrechen": ls.set("sk_einladung", null); closeModal(); break;
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
    busy("Lade Daten …");
    await ladeVerbindungen();
    if (!aktiv() && S.betriebe.length) { S.active = S.betriebe[0].key; speichereBetriebe(); }
    for (const b of S.betriebe) {
      try { await ladeBetrieb(b, true); } catch (e) { console.warn(e); if (b === aktiv()) fehler(e); }
    }
    busy(null);
    if (!aktiv()) S.view = "einstellungen";
  }
  render();
  if (S.account && ls.get("sk_einladung", null)) await einladungAnnehmen();
  else if (S.account) pruefeFaelligBeimOeffnen();
})();
