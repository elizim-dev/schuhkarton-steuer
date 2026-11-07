// Feste Konfiguration der App „Schuhkarton Steuer“
export const VERSION = "1.0.0";

export const CLIENT_ID = "e15c462d-09ab-471a-bda0-7b7b06581e86";
export const REGISTERED_REDIRECT = "https://elizim-dev.github.io/schuhkarton-steuer/";

// Lokal (Test) die aktuelle Adresse verwenden, sonst die registrierte Adresse
export const REDIRECT_URI =
  location.hostname === "elizim-dev.github.io"
    ? REGISTERED_REDIRECT
    : location.origin + location.pathname.replace(/index\.html$/, "");

export const SCOPES = ["Files.ReadWrite.All", "User.Read"];
export const GRAPH = "https://graph.microsoft.com/v1.0";

// Dateinamen im Betriebsordner
export const CONFIG_FILE = "schuhkarton-config.json";
export const JOURNAL_FILE = "schuhkarton-journal.json";
export const BELEGE_FOLDER = "Belege";

// KI
export const KI_MODELLE = [
  { id: "claude-haiku-5-5", label: "Haiku (günstig, schnell)" },
  { id: "claude-sonnet-5-5", label: "Sonnet (genauer)" },
];
export const KI_STANDARD = "claude-haiku-5-5";

// Pauschalen (Stand 2026 – bei Gesetzesänderungen anpassen)
export const KM_PAUSCHALE_CENT = 30; // 0,30 € je gefahrenem km (Dienstreise, eigener Pkw)
export const HOMEOFFICE_TAG_CENT = 600; // 6 € je Tag
export const HOMEOFFICE_MAX_CENT = 126000; // 1.260 € je Jahr

export const KATEGORIEN_EINNAHME = [
  "Betriebseinnahmen (Kleinunternehmer)",
  "Sonstige Einnahmen",
];

export const KATEGORIEN_AUSGABE = [
  "Software, Abos, Lizenzen",
  "Hardware unter 800 € (GWG)",
  "Bürobedarf, Porto",
  "Telefon, Internet (anteilig)",
  "Fortbildung, Fachliteratur",
  "Reise- und Fahrtkosten",
  "Werbung, Website, Hosting",
  "Bewirtung (70 %)",
  "Versicherungen, Beiträge (betrieblich)",
  "Fremdleistungen",
  "Bankgebühren",
  "Raumkosten, Homeoffice-Pauschale",
  "Sonstige Ausgaben",
];

export const EIGENBELEG_GRUENDE = [
  "Pauschale (kein Beleg vorgesehen)",
  "Originalbeleg verloren",
  "Kein Beleg ausgestellt",
  "Interne Buchung (Einlage/Entnahme)",
  "Sonstiges",
];
