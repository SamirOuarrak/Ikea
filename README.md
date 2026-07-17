# IKEA Maroc — Suivi des prix

Backend Node.js qui scrape quotidiennement les prix de tout le catalogue IKEA Maroc,
garde un historique, détecte les nouveaux produits, et affiche l'évolution des prix
dans un mini dashboard web (Chart.js).

## Installation

```bash
cd ikea-price-tracker
npm install
```

## Test rapide (1 seul produit, avant de lancer le crawl complet)

Crée un fichier `test.js` :

```js
const { scrapeProduct } = require('./scraper');
scrapeProduct('https://www.ikea.com/ma/fr/p/paerkla-storage-case-50395382/')
  .then(console.log)
  .catch(console.error);
```

```bash
node test.js
```

Regarde la console : le champ `method` te dit si l'extraction a réussi via `json-ld`
(idéal) ou `regex-fallback` (fonctionne mais plus fragile). Si `null` est retourné,
suis les instructions en haut de `scraper.js` pour ajuster la regex — ouvre la page
produit dans un navigateur, clic droit → "Afficher le code source" (le vrai HTML, pas
l'inspecteur), et cherche `DH` ou `application/ld+json`.

## Lancer le serveur (API + frontend + cron quotidien)

```bash
npm start
```

Ouvre `http://localhost:3000`. Le premier lancement, la base est vide — clique sur
"Rechercher" ne donnera rien tant qu'un scrape n'a pas tourné.

## Lancer un scrape complet manuellement

```bash
npm run scrape:now
```

⚠️ Sur tout le catalogue (potentiellement plusieurs milliers de produits), ce premier
run peut prendre du temps (délai de politesse de 300-400ms entre chaque requête pour
ne pas surcharger le serveur IKEA). Compte large pour le premier passage — les runs
suivants ne réécrivent l'historique que si le prix a changé, donc la base grossit peu.

Le cron dans `server.js` relance ça automatiquement tous les jours à 6h00
(`cron.schedule('0 6 * * *', ...)`), tant que le process Node tourne.

## Compléter la pagination (pour couvrir 100% du catalogue)

Les pages catégorie IKEA affichent ~24 produits puis un bouton "Show more" en
JavaScript, qui déclenche probablement un appel à une API interne paginée.

Pour la trouver :
1. Ouvre une page catégorie IKEA (ex: `ikea.com/ma/fr/cat/lowest-price/`) dans Chrome
2. Ouvre les DevTools → onglet **Network** → filtre **Fetch/XHR**
3. Clique sur "Show more" et regarde la nouvelle requête qui apparaît
4. Copie son URL (et les paramètres) — envoie-la moi, on branche ça dans
   `discoverAllProductUrls()` en 2 minutes.

En attendant, le crawler couvre déjà la première page de **chaque** sous-catégorie du
site (elles sont nombreuses), ce qui remonte une large portion du catalogue dès le
premier run.

## Où l'héberger pour qu'il tourne "en continu"

Un process Node avec `node-cron` a besoin d'un serveur qui reste allumé (contrairement
à GitHub Actions qui est ponctuel). Options simples et pas chères :
- **Railway** ou **Render** — déploiement direct depuis GitHub, offre gratuite limitée
  puis quelques dollars/mois, gèrent le redémarrage automatique
- **VPS** (ex: OVH, Contabo) — plus de contrôle, un peu plus de config (PM2 pour garder
  le process actif)
- Ta machine perso avec **PM2** (`pm2 start server.js`) si elle reste allumée

Le fichier `ikea.db` (SQLite) doit être sur un disque persistant — vérifie que
l'hébergeur choisi ne réinitialise pas le filesystem à chaque déploiement (Railway/
Render proposent des "volumes" persistants, à activer).

## Structure du projet

```
ikea-price-tracker/
├── db.js          → schéma SQLite (products, price_history, scrape_runs)
├── scraper.js      → découverte des produits + extraction du prix
├── server.js        → API Express + planification cron
├── public/index.html → dashboard (recherche, nouveautés, historique en graphique)
└── package.json
```

## Endpoints API

- `GET /api/products?q=...` — recherche/liste des produits
- `GET /api/products/:articleNumber/history` — historique de prix d'un produit
- `GET /api/products/new?days=7` — produits ajoutés récemment par IKEA
- `GET /api/products/price-drops?days=7` — produits dont le prix a changé
- `GET /api/scrape-runs` — journal des exécutions du scraper
- `POST /api/scrape/run-now` — déclenche un scrape immédiatement
