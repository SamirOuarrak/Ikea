// db.js — connexion SQLite + schéma
// Un seul fichier ikea.db à la racine du projet. Aucune installation de serveur DB requise.

const Database = require('better-sqlite3');
const path = require('path');

// En production sur Railway, DB_DIR pointe vers le volume monté (ex: /app/data)
// pour que la base survive aux redéploiements. En local, ça reste dans le dossier du projet.
const dbDir = process.env.DB_DIR || __dirname;
const db = new Database(path.join(dbDir, 'ikea.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  article_number   TEXT PRIMARY KEY,     -- ex: "503.953.82" (clé stable côté IKEA)
  name              TEXT NOT NULL,
  slug_url          TEXT NOT NULL,       -- URL complète de la page produit
  category          TEXT,
  image_url         TEXT,
  current_price     REAL,
  currency          TEXT DEFAULT 'DH',
  unit_note         TEXT,                -- ex: "/2 pieces", "/4 pieces"
  first_seen_at     TEXT DEFAULT (datetime('now')),
  last_checked_at   TEXT,
  is_active         INTEGER DEFAULT 1    -- passe à 0 si le produit disparaît du site (retiré du catalogue)
);

CREATE TABLE IF NOT EXISTS price_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  article_number  TEXT NOT NULL,
  price           REAL NOT NULL,
  currency        TEXT DEFAULT 'DH',
  checked_at      TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_number) REFERENCES products(article_number)
);

CREATE INDEX IF NOT EXISTS idx_price_history_article ON price_history(article_number);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT DEFAULT (datetime('now')),
  finished_at     TEXT,
  products_found  INTEGER,
  products_seen   INTEGER,
  products_new    INTEGER,
  prices_changed  INTEGER,
  status          TEXT
);

CREATE TABLE IF NOT EXISTS watchlist (
  article_number  TEXT PRIMARY KEY,
  target_price    REAL NOT NULL,
  created_at      TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_number) REFERENCES products(article_number)
);
`);

// Ajoute la colonne si la base existe déjà depuis une version précédente (sans planter si elle existe déjà)
try {
  db.exec('ALTER TABLE scrape_runs ADD COLUMN products_found INTEGER');
} catch (e) {
  /* colonne déjà présente, on ignore */
}

module.exports = db;
