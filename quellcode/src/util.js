// Hilfsfunktionen: Formatierung, Bilder/PDF, Eigenbeleg, Excel, KI
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import { KATEGORIEN_AUSGABE as ALLE_AUSGABEN, KATEGORIEN_EINNAHME, NUR_REISE_KATEGORIEN } from "./config.js";
// Für die KI: keine Kategorien, die nur über „Reise“ gebucht werden
const KATEGORIEN_AUSGABE = ALLE_AUSGABEN.filter((k) => !NUR_REISE_KATEGORIEN.includes(k));

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Nur https-Links zulassen (Links stammen aus Dateien im geteilten Ordner)
export const safeUrl = (u) => (/^https:\/\//i.test(String(u || "")) ? String(u) : "");

export const heute = () => new Date().toLocaleDateString("sv-SE");
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export function euro(cent) {
  return (cent / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
export function betragText(cent) {
  return (cent / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
}
export function parseBetrag(str) {
  if (typeof str === "number") return Math.round(str * 100);
  let s = String(str || "").replace(/[€\s]/g, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? NaN : Math.round(n * 100);
}
export function datumDE(iso) {
  if (!iso) return "–";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function dateiname(e, kurz) {
  const clean = (s) =>
    String(s || "")
      .replace(/[\\/:*?"<>|#%&{}~]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 40) || "ohne-Name";
  const rb = e.reise && e.reise.baustein;
  const partner = e.fahrt
    ? "Fahrt-" + e.fahrt.fahrerin
    : rb === "pkw" ? "Fahrt-" + e.reise.person
    : rb === "verpflegung" ? "Verpflegung-" + e.reise.person
    : e.art === "einlage" || e.art === "entnahme" ? (e.art === "einlage" ? "Einlage-" : e.entnahmeArt === "gewinn" ? "Gewinnauszahlung-" : "Entnahme-") + e.gesellschafterin : e.partner;
  const prefix = e.eigenbeleg ? "Eigenbeleg_" : "";
  return `${e.belegdatum}_${clean(kurz)}_${prefix}${clean(partner)}_${betragText(e.betragCent)}.pdf`;
}

// --- Bilder -----------------------------------------------------------------

export function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Bild verkleinern und als JPEG zurückgeben
export async function compressImage(file, maxSide = 2000, quality = 0.8) {
  const url = await fileToDataURL(file);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Bild konnte nicht geladen werden"));
    i.src = url;
  });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: c.toDataURL("image/jpeg", quality), w, h };
}

// Mehrere Bilder → ein PDF (A4)
export function bilderZuPdf(pages) {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const maxW = 190;
  const maxH = 277;
  pages.forEach((p, i) => {
    if (i > 0) pdf.addPage();
    const r = Math.min(maxW / p.w, maxH / p.h);
    const w = p.w * r;
    const h = p.h * r;
    pdf.addImage(p.dataUrl, "JPEG", (210 - w) / 2, 10, w, h);
  });
  return pdf.output("blob");
}

// Eigenbeleg als PDF
export function eigenbelegPdf(e, betrieb, ersteller) {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  let y = 25;
  pdf.setFontSize(18);
  pdf.text("Eigenbeleg", 20, y);
  pdf.setFontSize(10);
  pdf.text(`Beleg-Nr.: ${e.belegnr || "–"}`, 150, y);
  y += 12;
  const zeile = (label, wert) => {
    pdf.setFont(undefined, "bold");
    pdf.text(label, 20, y);
    pdf.setFont(undefined, "normal");
    const lines = pdf.splitTextToSize(String(wert || "–"), 120);
    pdf.text(lines, 70, y);
    y += 7 * lines.length;
  };
  const artText = { ausgabe: "Ausgabe", einnahme: "Einnahme", einlage: "Einlage", entnahme: "Entnahme" }[e.art];
  const r = e.reise;
  const zeitText = (d, z) => `${datumDE(d)}${z ? `, ${z} Uhr` : ""}`;
  const reiseZeilen = () => {
    if (!r) return;
    zeile("Reise:", `${r.ziel} – ${r.anlass}`);
    zeile("Abfahrt:", zeitText(r.abDatum, r.abZeit));
    zeile("Rückkehr:", zeitText(r.anDatum, r.anZeit));
  };
  const fuss = () => {
    zeile("Grund Eigenbeleg:", e.eigenbelegGrund);
    y += 6;
    zeile("Erstellt von:", ersteller);
    zeile("Erstellt am:", datumDE(heute()));
    y += 20;
    pdf.line(20, y, 100, y);
    pdf.setFontSize(8);
    pdf.text("Unterschrift", 20, y + 5);
    pdf.text("Erstellt mit Schuhkarton Steuer", 20, 287);
    return pdf.output("blob");
  };
  if (r && r.baustein === "verpflegung" && r.verpflegung) {
    const gbr = e.behandlung === "sonderbetriebsausgabe";
    zeile("Betrieb:", betrieb.name);
    zeile("Art:", `Verpflegungsmehraufwand (Pauschalen Inland)${gbr ? " – Sonderbetriebsausgabe" : ""}`);
    zeile("Reisende Person:", r.person);
    reiseZeilen();
    y += 3;
    const TYP = { eintaegig: "eintägig", anreise: "Anreisetag", abreise: "Abreisetag", zwischen: "voller Tag" };
    pdf.setFont(undefined, "bold");
    pdf.text("Tag", 20, y); pdf.text("Pauschale", 70, y); pdf.text("Gestellt", 100, y); pdf.text("Kürzung", 140, y); pdf.text("Betrag", 170, y);
    pdf.setFont(undefined, "normal");
    y += 6;
    for (const t of r.verpflegung.tage) {
      const g = [t.mahlzeiten.f && "Frühstück", t.mahlzeiten.m && "Mittag", t.mahlzeiten.a && "Abend"].filter(Boolean).join(", ") || "–";
      pdf.text(`${datumDE(t.datum)} (${TYP[t.typ] || t.typ}${t.typ === "eintaegig" ? `, ${String(t.stunden).replace(".", ",")} Std.` : ""})`, 20, y);
      pdf.text(euro(t.pauschale), 70, y);
      pdf.text(pdf.splitTextToSize(g, 38), 100, y);
      pdf.text(t.kuerzung ? "- " + euro(t.kuerzung) : "–", 140, y);
      pdf.text(euro(t.betrag), 170, y);
      y += g.length > 22 ? 10 : 6;
    }
    pdf.setFont(undefined, "bold");
    pdf.text("Summe", 20, y); pdf.text(euro(e.betragCent), 170, y);
    pdf.setFont(undefined, "normal");
    y += 9;
    zeile("Grundlage:", "§ 4 Abs. 5 Nr. 5 i. V. m. § 9 Abs. 4a EStG: 14 € bei mehr als 8 Std. sowie An- und Abreisetag, 28 € je voller Tag; Kürzung je gestellter Mahlzeit 5,60 € (Frühstück) bzw. 11,20 € (Mittag-/Abendessen)");
    return fuss();
  }
  if (e.fahrt) {
    const f = e.fahrt;
    const satz = (c) => (c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 }) + " €";
    zeile("Betrieb:", betrieb.name);
    zeile("Art:", "Fahrt mit eigenem Pkw (Fahrzeug im Privatvermögen)");
    zeile("Fahrtdatum:", datumDE(e.belegdatum));
    zeile("Fahrerin:", f.fahrerin);
    zeile("Mitfahrerin:", f.mitfahrerin || "keine");
    zeile("Strecke:", `${f.start} – ${f.ziel}${f.hinUndZurueck ? " und zurück" : ""}`);
    zeile("Anlass:", f.anlass);
    if (r && r.abZeit) { zeile("Abfahrt:", zeitText(r.abDatum, r.abZeit)); zeile("Rückkehr:", zeitText(r.anDatum, r.anZeit)); }
    zeile("Gefahrene km:", f.hinUndZurueck ? `2 × ${f.km} km = ${f.kmGesamt} km` : `${f.kmGesamt} km`);
    y += 3;
    zeile("Erstattung GbR:", `${f.kmGesamt} km × ${satz(f.satzCent)} = ${euro(e.betragCent)}`);
    zeile("", e.status === "bezahlt" ? `überwiesen am ${datumDE(e.zahlungsdatum)}` : "Überweisung offen (Abrechnung zum Jahresende)");
    zeile("", "Betriebsausgabe der GbR; bei der Fahrerin Sonderbetriebseinnahme");
    zeile("Sonderbetriebs-", `${f.kmGesamt} km × ${satz(f.sbaSatzCent)} = ${euro(f.sbaCent)}`);
    zeile("ausgabe Fahrerin:", "Pauschale für Fahrten mit dem eigenen Pkw");
    zeile("Grund Eigenbeleg:", e.eigenbelegGrund);
    y += 6;
    zeile("Erstellt von:", ersteller);
    zeile("Erstellt am:", datumDE(heute()));
    y += 20;
    pdf.line(20, y, 100, y);
    pdf.setFontSize(8);
    pdf.text("Unterschrift", 20, y + 5);
    pdf.text("Erstellt mit Schuhkarton Steuer", 20, 287);
    return pdf.output("blob");
  }
  zeile("Betrieb:", betrieb.name);
  zeile("Art:", artText);
  zeile("Datum:", datumDE(e.belegdatum));
  zeile("Betrag:", euro(e.betragCent));
  if (e.art === "einlage" || e.art === "entnahme") zeile("Gesellschafterin:", e.gesellschafterin);
  else zeile(e.art === "einnahme" ? "Zahlende/r:" : "Empfänger/in:", e.partner);
  if (e.kategorie) zeile("Kategorie:", e.kategorie);
  zeile("Zweck / Anlass:", e.beschreibung);
  if (r) { zeile("Reisende Person:", r.person); reiseZeilen(); if (r.pkw) zeile("Strecke:", `${r.pkw.start} – ${r.ziel}${r.pkw.hinUndZurueck ? " und zurück" : ""}, ${String(r.pkw.kmGesamt).replace(".", ",")} km`); }
  if (e.anteilProzent) zeile("Betrieblicher Anteil:", `${String(e.anteilProzent).replace(".", ",")} % von ${euro(e.gesamtCent)}`);
  if (e.bewAnlass) { zeile("Bewirtung Anlass:", e.bewAnlass); zeile("Teilnehmende:", e.bewTeilnehmende); zeile("Ort:", e.bewOrt); }
  zeile("Grund Eigenbeleg:", e.eigenbelegGrund);
  if (e.pauschale) zeile("Berechnung:", e.pauschale);
  y += 6;
  zeile("Erstellt von:", ersteller);
  zeile("Erstellt am:", datumDE(heute()));
  y += 20;
  pdf.line(20, y, 100, y);
  pdf.setFontSize(8);
  pdf.text("Unterschrift", 20, y + 5);
  pdf.text("Erstellt mit Schuhkarton Steuer", 20, 287);
  return pdf.output("blob");
}

// --- Excel-Spiegel des Journals --------------------------------------------

const ART_TEXT = { ausgabe: "Ausgabe", einnahme: "Einnahme", einlage: "Einlage", entnahme: "Entnahme" };
const BEHANDLUNG_TEXT = { einlage: "Einlage", erstattung: "wird erstattet", sonderbetriebsausgabe: "Sonderbetriebsausgabe" };

export function journalExcel(journal, config) {
  const wb = XLSX.utils.book_new();
  const jahre = [...new Set(journal.eintraege.map((e) => (e.zahlungsdatum || e.belegdatum).slice(0, 4)))].sort();
  for (const jahr of jahre) {
    const rows = journal.eintraege
      .filter((e) => (e.zahlungsdatum || e.belegdatum).startsWith(jahr))
      .sort((a, b) => (a.belegnr || "").localeCompare(b.belegnr || ""))
      .map((e) => ({
        "Beleg-Nr.": e.belegnr,
        Belegdatum: e.belegdatum,
        Zahlungsdatum: e.zahlungsdatum || "",
        Art: ART_TEXT[e.art] || e.art,
        "Betrag (€)": (e.art === "ausgabe" || e.art === "entnahme" ? -1 : 1) * (e.betragCent / 100),
        Kategorie: e.kategorie || "",
        "Lieferant/Kunde": e.partner || e.gesellschafterin || "",
        Beschreibung: e.beschreibung || "",
        "Rechnungs-Nr.": e.rechnungsnr || "",
        Status: e.storniert ? "storniert" : e.status,
        "Bezahlt von": e.bezahltVon === "betrieb" || !e.bezahltVon ? "" : e.bezahltVon,
        Behandlung: BEHANDLUNG_TEXT[e.behandlung] || "",
        Eigenbeleg: e.eigenbeleg ? "ja" : "",
        "Anteil %": e.anteilProzent || "",
        "Rechnungsbetrag (€)": e.gesamtCent ? e.gesamtCent / 100 : "",
        "Bewirtung (Anlass / Teilnehmende / Ort)": e.bewAnlass ? `${e.bewAnlass} / ${e.bewTeilnehmende} / ${e.bewOrt}` : "",
        "Erfasst von": e.erfasstVon || "",
        Datei: e.datei ? e.datei.name : "",
        Reise: e.reise ? `${e.reise.ziel} · ${e.reise.anlass} · ${e.reise.abDatum}${e.reise.anDatum && e.reise.anDatum !== e.reise.abDatum ? " bis " + e.reise.anDatum : ""} · ${e.reise.person}` : "",
        Fahrt: e.fahrt
          ? `${e.fahrt.fahrerin}${e.fahrt.mitfahrerin ? " mit " + e.fahrt.mitfahrerin : ""} · ${e.fahrt.start} – ${e.fahrt.ziel}${e.fahrt.hinUndZurueck ? " und zurück" : ""} · ${e.fahrt.kmGesamt} km · SBA ${(e.fahrt.sbaCent / 100).toFixed(2).replace(".", ",")} €`
          : "",
      }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [10, 11, 13, 10, 11, 28, 24, 32, 14, 10, 14, 20, 10, 8, 14, 36, 16, 40, 40, 60].map((w) => ({ wch: w }));
    rows.forEach((r, i) => {
      const e = journal.eintraege.find((x) => x.belegnr === r["Beleg-Nr."]);
      const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 17 })];
      if (cell && e && e.datei && safeUrl(e.datei.webUrl)) cell.l = { Target: e.datei.webUrl };
    });
    XLSX.utils.book_append_sheet(wb, ws, jahr);
  }
  const hinweis = XLSX.utils.aoa_to_sheet([
    ["Automatisch erzeugt von Schuhkarton Steuer"],
    [`Betrieb: ${config.name}`],
    [`Stand: ${new Date().toLocaleString("de-DE")}`],
    ["Änderungen bitte in der App vornehmen – diese Datei wird bei jeder Speicherung überschrieben."],
  ]);
  XLSX.utils.book_append_sheet(wb, hinweis, "Hinweis");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// --- KI-Auslesen (Claude) -----------------------------------------------------

function base64Of(dataUrl) {
  return dataUrl.split(",")[1];
}
async function blobToBase64(blob) {
  return base64Of(await fileToDataURL(blob));
}

export async function kiAuslesen({ apiKey, modell, pages, pdfBlob, config }) {
  const content = [];
  if (pdfBlob) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: await blobToBase64(pdfBlob) } });
  } else {
    for (const p of pages.slice(0, 5)) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Of(p.dataUrl) } });
    }
  }
  const personen = (config.gesellschafter || []).map((g) => g.name).filter(Boolean).join(", ");
  const prompt = `Du liest einen deutschen Beleg (Rechnung, Quittung, Kassenbon) für die Buchhaltung (Einnahmen-Überschuss-Rechnung) aus.
Der Betrieb heißt „${config.name}“${personen ? ` (Personen: ${personen})` : ""}. Der Betrieb ist Kleinunternehmer (keine Umsatzsteuer), daher zählt immer der Bruttobetrag.
Entscheide: Stellt der Betrieb die Rechnung aus (= "einnahme") oder ist der Betrieb Empfänger/Käufer (= "ausgabe")?
Wähle die Kategorie exakt aus einer dieser Listen:
Ausgaben: ${KATEGORIEN_AUSGABE.join(" | ")}
Einnahmen: ${KATEGORIEN_EINNAHME.join(" | ")}
Heute ist ${heute()}.
Trage die Daten über das Werkzeug „beleg_daten“ ein. Beträge als Zahl in Euro (Punkt als Dezimaltrenner), Datumsangaben als JJJJ-MM-TT. Liste in „unsicher“ die Feldnamen, bei denen du nicht sicher bist.`;
  content.push({ type: "text", text: prompt });

  const tool = {
    name: "beleg_daten",
    description: "Ausgelesene Daten eines Belegs für die Buchhaltung",
    input_schema: {
      type: "object",
      properties: {
        art: { type: "string", enum: ["ausgabe", "einnahme"] },
        belegdatum: { type: "string", description: "JJJJ-MM-TT" },
        betrag: { type: "number", description: "Bruttogesamtbetrag in Euro" },
        waehrung: { type: "string" },
        partner: { type: "string", description: "Aussteller bei Ausgabe, Kunde bei Einnahme" },
        rechnungsnr: { type: "string" },
        kategorie: { type: "string", enum: [...KATEGORIEN_AUSGABE, ...KATEGORIEN_EINNAHME] },
        beschreibung: { type: "string", description: "kurz, max. 8 Wörter" },
        bezahlt: { type: ["boolean", "null"], description: "true, wenn erkennbar bezahlt (Kassenbon, Kartenzahlung, 'bezahlt')" },
        zahlungsdatum: { type: ["string", "null"], description: "JJJJ-MM-TT oder null" },
        begruendung: { type: "string", description: "ein Satz, warum diese Kategorie" },
        unsicher: { type: "array", items: { type: "string" } },
      },
      required: ["art", "belegdatum", "betrag", "partner", "kategorie"],
    },
  };

  const anfrage = async (mitWerkzeug) => {
    const body = { model: modell, max_tokens: 2000, messages: [{ role: "user", content }] };
    if (mitWerkzeug) {
      body.tools = [tool];
      body.tool_choice = { type: "tool", name: "beleg_daten" };
    } else {
      body.messages[0].content = [...content.slice(0, -1), { type: "text", text: prompt + "\nAntworte ausschließlich mit einem JSON-Objekt mit den Feldern art, belegdatum, betrag, waehrung, partner, rechnungsnr, kategorie, beschreibung, bezahlt, zahlungsdatum, begruendung, unsicher." }];
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, j };
  };

  let r = await anfrage(true);
  // Falls das Modell Werkzeuge in dieser Form nicht annimmt: Textmodus
  if (!r.ok && r.status === 400) r = await anfrage(false);
  if (!r.ok) throw new Error("KI-Fehler: " + ((r.j.error && r.j.error.message) || r.status));

  const bloecke = r.j.content || [];
  const werkzeug = bloecke.find((c) => c.type === "tool_use" && c.input);
  if (werkzeug) return werkzeug.input;
  const text = bloecke.filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  const info = r.j.stop_reason === "max_tokens" ? "Antwort zu lang abgebrochen" : text ? `„${text.slice(0, 120)}…“` : `keine Textantwort (${bloecke.map((c) => c.type).join(", ") || "leer"})`;
  throw new Error("KI-Antwort nicht lesbar: " + info);
}

export async function kiTest(apiKey, modell) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: modell, max_tokens: 10, messages: [{ role: "user", content: "Antworte nur mit OK." }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || "Fehler " + res.status);
  return true;
}

// --- PDF „EÜR <Jahr>“ ----------------------------------------------------------
export function euerPdf({ config, jahr, eu, gesellschaft, eintraege, ersteller, fahrten }) {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const L = 18;
  const R = 192;
  let y = 20;
  const neueSeite = () => { pdf.addPage(); y = 20; };
  const platz = (h) => { if (y + h > 280) neueSeite(); };
  const text = (t, x, opts = {}) => pdf.text(String(t), x, y, opts);
  pdf.setFontSize(16); pdf.setFont(undefined, "bold"); text(`Einnahmenüberschussrechnung ${jahr}`, L);
  y += 8; pdf.setFontSize(10); pdf.setFont(undefined, "normal");
  text(`${config.name}${config.steuernummer ? " · Steuernummer " + config.steuernummer : ""}`, L); y += 5;
  text(`${config.kleinunternehmer !== false ? "Kleinunternehmerregelung (§ 19 UStG) – Beträge brutto" : ""}`, L); y += 5;
  text(`Stand: ${new Date().toLocaleString("de-DE")} · erstellt von ${ersteller}`, L); y += 9;

  const kopfzeile = (cols) => {
    platz(8); pdf.setFont(undefined, "bold");
    cols.forEach(([t, x, a]) => text(t, x, a ? { align: a } : {}));
    pdf.setFont(undefined, "normal"); y += 2; pdf.line(L, y, R, y); y += 5;
  };
  const zeilen = (z, betrag, fett) => {
    const lines = pdf.splitTextToSize(z.bez + (z.nichtAbziehbar ? ` (gesamt ${euro(z.brutto)}, nicht abziehbar ${euro(z.nichtAbziehbar)})` : ""), 120);
    platz(5 * lines.length + 1);
    if (fett) pdf.setFont(undefined, "bold");
    text(z.zeile || (fett ? "" : "–"), L); pdf.text(lines, L + 16, y); text(euro(betrag), R, { align: "right" });
    pdf.setFont(undefined, "normal"); y += 5 * lines.length;
  };
  pdf.setFontSize(12); pdf.setFont(undefined, "bold"); text("Betriebseinnahmen", L); y += 7; pdf.setFontSize(10);
  kopfzeile([["Zeile", L], ["Bezeichnung", L + 16], ["Betrag", R, "right"]]);
  eu.zeilen.filter((z) => z.typ === "einnahme" && z.betrag).forEach((z) => zeilen(z, z.betrag));
  zeilen({ zeile: "23", bez: "Summe Betriebseinnahmen" }, eu.be, true); y += 5;
  pdf.setFontSize(12); pdf.setFont(undefined, "bold"); platz(14); text("Betriebsausgaben", L); y += 7; pdf.setFontSize(10);
  kopfzeile([["Zeile", L], ["Bezeichnung", L + 16], ["Betrag", R, "right"]]);
  eu.zeilen.filter((z) => z.typ === "ausgabe" && z.brutto).forEach((z) => zeilen(z, z.betrag));
  zeilen({ zeile: "", bez: "Summe Betriebsausgaben" }, eu.ba, true); y += 4;
  pdf.line(L, y, R, y); y += 6;
  pdf.setFontSize(12); zeilen({ zeile: "", bez: eu.gewinn >= 0 ? "Gewinn" : "Verlust" }, eu.gewinn, true); pdf.setFontSize(10);
  y += 4;
  pdf.setFontSize(8);
  const hinweis = pdf.splitTextToSize("Zeilennummern laut Vordruck Anlage EÜR 2026, soweit eindeutig belegt; bei „–“ bitte anhand der Bezeichnung zuordnen. Maßgeblich ist die Bezeichnung im Steuerprogramm.", R - L);
  platz(4 * hinweis.length); pdf.text(hinweis, L, y); y += 4 * hinweis.length + 4; pdf.setFontSize(10);

  if (gesellschaft) {
    platz(30);
    pdf.setFontSize(12); pdf.setFont(undefined, "bold"); text("Für die Feststellungserklärung", L); y += 7; pdf.setFontSize(10);
    const cols = gesellschaft.personen.map((p, i) => [p.name, R - (gesellschaft.personen.length - 1 - i) * 40, "right"]);
    kopfzeile([["", L], ...cols]);
    const reihe = (label, key, fett) => {
      platz(6); if (fett) pdf.setFont(undefined, "bold");
      text(label, L);
      gesellschaft.personen.forEach((p, i) => text(euro(p[key]), R - (gesellschaft.personen.length - 1 - i) * 40, { align: "right" }));
      pdf.setFont(undefined, "normal"); y += 5;
    };
    gesellschaft.personen.forEach((p) => (p.steuerAnteil = p.gewinnSteuer + p.sba - (p.sbe || 0)));
    reihe("Anteil am Gewinn", "steuerAnteil");
    if (gesellschaft.personen.some((p) => p.sbe)) reihe("+ Sonderbetriebseinnahmen", "sbe");
    reihe("- Sonderbetriebsausgaben", "sba");
    reihe("= Gewinnanteil", "gewinnSteuer", true);
    y += 3; pdf.setFontSize(9); pdf.setFont(undefined, "italic"); text("Informativ (ohne steuerliche Wirkung):", L); pdf.setFont(undefined, "normal"); y += 5;
    reihe("Einlagen", "einlagen");
    reihe("Entnahmen", "entnahmen");
    if (gesellschaft.personen.some((p) => p.gewinnAusz)) reihe("  davon Gewinnauszahlungen", "gewinnAusz");
    reihe("Kapitalkonto", "kapital");
    pdf.setFontSize(10); y += 6;
  }

  if (fahrten && fahrten.fahrten.length) {
    neueSeite();
    pdf.setFontSize(12); pdf.setFont(undefined, "bold"); text(`Fahrtenliste ${jahr}`, L); y += 6;
    pdf.setFontSize(8); pdf.setFont(undefined, "normal");
    const satzInfo = pdf.splitTextToSize("Fahrten mit privaten Pkw der Gesellschafterinnen. Erstattung durch die GbR = Betriebsausgabe der GbR und Sonderbetriebseinnahme der Fahrerin (im Jahr der Überweisung); Pauschale 0,30 €/km = Sonderbetriebsausgabe der Fahrerin (im Jahr der Fahrt).", R - L);
    pdf.text(satzInfo, L, y); y += 4 * satzInfo.length + 3;
    kopfzeile([["Datum", L], ["Strecke / Anlass", L + 18], ["Fahrerin", L + 88], ["km", L + 134, "right"], ["Erstattung", L + 156, "right"], ["Status", R, "right"]]);
    for (const e of fahrten.fahrten) {
      const f = e.fahrt;
      const strecke = pdf.splitTextToSize(`${f.start} – ${f.ziel}${f.hinUndZurueck ? " u. zurück" : ""}: ${f.anlass}`, 66);
      const wer = pdf.splitTextToSize(`${f.fahrerin}${f.mitfahrerin ? " (mit " + f.mitfahrerin + ")" : ""}`, 34);
      const h = 4 * Math.max(strecke.length, wer.length);
      platz(h + 1);
      text(datumDE(e.belegdatum), L); pdf.text(strecke, L + 18, y); pdf.text(wer, L + 88, y);
      text(String(f.kmGesamt).replace(".", ","), L + 134, { align: "right" }); text(euro(e.betragCent), L + 156, { align: "right" });
      text(e.status === "bezahlt" ? datumDE(e.zahlungsdatum) : "offen", R, { align: "right" });
      y += h + 1;
    }
    y += 3; pdf.line(L, y, R, y); y += 5;
    pdf.setFontSize(9);
    kopfzeile([["Je Fahrerin", L], ["Fahrten", L + 70, "right"], ["km", L + 92, "right"], ["SBA 0,30 €/km", L + 124, "right"], ["überwiesen", L + 152, "right"], ["offen", R, "right"]]);
    for (const p of fahrten.personen) {
      platz(6);
      text(p.name, L); text(String(p.anzahl), L + 70, { align: "right" }); text(String(p.km).replace(".", ","), L + 92, { align: "right" });
      text(euro(p.sba), L + 124, { align: "right" }); text(euro(p.ueberwiesenCent), L + 152, { align: "right" }); text(euro(p.offenCent), R, { align: "right" });
      y += 5;
    }
  }

  neueSeite();
  pdf.setFontSize(12); pdf.setFont(undefined, "bold"); text(`Belegliste ${jahr}`, L); y += 7; pdf.setFontSize(8);
  kopfzeile([["Nr.", L], ["Bezahlt", L + 18], ["Partner / Beschreibung", L + 38], ["Kategorie", L + 110], ["Betrag", R, "right"]]);
  pdf.setFont(undefined, "normal");
  for (const e of eintraege) {
    const minus = e.art === "ausgabe" || e.art === "entnahme";
    const partner = pdf.splitTextToSize(`${e.partner || e.gesellschafterin || ""}${e.beschreibung ? " – " + e.beschreibung : ""}`, 68);
    const kat = pdf.splitTextToSize((e.kategorie || (e.art === "einlage" ? "Einlage" : "Entnahme")) + (e.behandlung === "sonderbetriebsausgabe" ? " (SBA)" : ""), 46);
    const h = 4 * Math.max(partner.length, kat.length);
    platz(h + 1);
    text(e.belegnr, L); text(datumDE(e.zahlungsdatum), L + 18); pdf.text(partner, L + 38, y); pdf.text(kat, L + 110, y);
    text(`${minus ? "-" : "+"}${euro(e.betragCent)}`, R, { align: "right" });
    y += h + 1;
  }
  return pdf.output("blob");
}
