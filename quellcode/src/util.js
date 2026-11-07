// Hilfsfunktionen: Formatierung, Bilder/PDF, Eigenbeleg, Excel, KI
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import { KATEGORIEN_AUSGABE, KATEGORIEN_EINNAHME } from "./config.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
  const partner =
    e.art === "einlage" || e.art === "entnahme" ? (e.art === "einlage" ? "Einlage-" : "Entnahme-") + e.gesellschafterin : e.partner;
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
  zeile("Betrieb:", betrieb.name);
  zeile("Art:", artText);
  zeile("Datum:", datumDE(e.belegdatum));
  zeile("Betrag:", euro(e.betragCent));
  if (e.art === "einlage" || e.art === "entnahme") zeile("Gesellschafterin:", e.gesellschafterin);
  else zeile(e.art === "einnahme" ? "Zahlende/r:" : "Empfänger/in:", e.partner);
  if (e.kategorie) zeile("Kategorie:", e.kategorie);
  zeile("Zweck / Anlass:", e.beschreibung);
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
        "Erfasst von": e.erfasstVon || "",
        Datei: e.datei ? e.datei.name : "",
      }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [10, 11, 13, 10, 11, 28, 24, 32, 14, 10, 14, 20, 10, 16, 40].map((w) => ({ wch: w }));
    rows.forEach((r, i) => {
      const e = journal.eintraege.find((x) => x.belegnr === r["Beleg-Nr."]);
      const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 14 })];
      if (cell && e && e.datei && e.datei.webUrl) cell.l = { Target: e.datei.webUrl };
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
Antworte NUR mit einem JSON-Objekt, ohne Erklärtext, mit diesen Feldern:
{"art":"ausgabe"|"einnahme","belegdatum":"JJJJ-MM-TT","betrag":Zahl (Bruttogesamtbetrag in Euro, Punkt als Dezimaltrenner),"waehrung":"EUR","partner":"Name des Geschäftspartners (Aussteller bei Ausgabe, Kunde bei Einnahme)","rechnungsnr":"…" oder "","kategorie":"…","beschreibung":"kurze Beschreibung, max. 8 Wörter","bezahlt":true|false|null (true wenn erkennbar bezahlt, z. B. Kassenbon, Kartenzahlung, 'bezahlt'),"zahlungsdatum":"JJJJ-MM-TT" oder null,"begruendung":"ein Satz, warum diese Kategorie","unsicher":["feldname", …]}`;
  content.push({ type: "text", text: prompt });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: modell, max_tokens: 800, messages: [{ role: "user", content }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = (j.error && j.error.message) || res.status;
    throw new Error("KI-Fehler: " + m);
  }
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("KI-Antwort nicht lesbar");
  return JSON.parse(m[0]);
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
