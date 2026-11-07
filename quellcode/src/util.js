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
