// scraper.js
//
// IMPORTANT — à lire avant le premier run :
// Ce scraper utilise 2 stratégies pour extraire le prix, de la plus fiable à la moins fiable :
//   1) Le bloc JSON-LD (schema.org "Product") que beaucoup de sites e-commerce, dont IKEA,
//      embarquent pour le SEO. C'est la méthode la plus robuste car indépendante du HTML/CSS.
//   2) Un fallback par expression régulière sur le texte brut (ex: "19,90DH") si le JSON-LD
//      est absent ou change de format.
//
// Avant de lancer le crawl complet, teste sur UN produit (voir README "Test rapide") et
// vérifie dans la console laquelle des deux méthodes a matché. Si aucune ne fonctionne,
// il faudra ajuster la regex — ouvre la page produit dans un navigateur, "Afficher le
// code source" (pas l'inspecteur, le vrai HTML livré par le serveur) et cherche "DH" ou
// "application/ld+json" pour voir le format exact.

const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

const BASE = 'https://www.ikea.com/ma/fr';
const ROOT_CATEGORY = `${BASE}/cat/products-products/`;

const client = axios.create({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'fr-MA,fr;q=0.9',
  },
  timeout: 20000,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Récupère le HTML brut d'une page
async function getHtml(url) {
  const res = await client.get(url);
  return res.data;
}

// Extrait tous les liens catégories (/cat/...) et produits (/p/...) d'une page
function extractLinks(html) {
  const $ = cheerio.load(html);
  const categoryLinks = new Set();
  const productLinks = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const full = href.startsWith('http') ? href : `https://www.ikea.com${href}`;
    if (!full.includes('ikea.com/ma/')) return;

    if (/\/cat\/[a-z0-9-]+\/?(\?|$)/i.test(full)) {
      categoryLinks.add(full.split('?')[0]);
    } else if (/\/p\/[a-z0-9-]+-\d+\/?$/i.test(full)) {
      productLinks.add(full.split('?')[0]);
    }
  });

  return { categoryLinks: [...categoryLinks], productLinks: [...productLinks] };
}

// Parcourt récursivement les catégories pour lister tous les produits, en gardant trace
// de la catégorie (nom lisible) dans laquelle chaque produit a été trouvé. Comme le parcours
// est en largeur (racine d'abord, puis sous-catégories), un produit retrouvé plus tard dans
// une sous-catégorie plus précise écrase l'affectation précédente — ce qui donne en général
// la catégorie la plus spécifique disponible.
// NOTE: les catégories IKEA affichent ~24 produits puis un bouton "Show more" en JS.
// Cette fonction couvre la 1ère page de chaque (sous-)catégorie, ce qui remonte déjà
// une très large partie du catalogue grâce au nombre élevé de sous-catégories.
async function discoverAllProductUrls({ maxCategories = 500 } = {}) {
  const visitedCategories = new Set();
  const toVisit = [ROOT_CATEGORY];
  const productCategoryMap = new Map(); // url produit -> nom de catégorie

  while (toVisit.length && visitedCategories.size < maxCategories) {
    const url = toVisit.shift();
    if (visitedCategories.has(url)) continue;
    visitedCategories.add(url);

    try {
      const html = await getHtml(url);
      const categoryName = extractCategoryName(html, url);
      const { categoryLinks, productLinks } = extractLinks(html);
      productLinks.forEach((p) => productCategoryMap.set(p, categoryName));
      categoryLinks.forEach((c) => {
        if (!visitedCategories.has(c)) toVisit.push(c);
      });
      console.log(`[discover] ${url} (${categoryName}) -> ${productLinks.length} produits, ${categoryLinks.length} sous-catégories`);
    } catch (err) {
      console.error(`[discover] échec sur ${url}: ${err.message}`);
    }

    await sleep(400); // politesse envers le serveur, évite le rate-limiting
  }

  return [...productCategoryMap.entries()].map(([url, categoryName]) => ({ url, categoryName }));
}

// Nom de catégorie lisible : essaie le H1 de la page, sinon dérive le slug de l'URL
function extractCategoryName(html, url) {
  const $ = cheerio.load(html);
  const h1 = $('h1').first().text().trim();
  if (h1) return h1;

  const match = url.match(/\/cat\/([a-z0-9-]+)\/?$/i);
  if (!match) return 'Autre';
  return match[1]
    .replace(/-\d+$/, '') // retire le suffixe numérique d'ID
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Extrait { articleNumber, name, price, currency, unitNote, imageUrl } d'une page produit
function parseProductPage(html, url) {
  const $ = cheerio.load(html);

  // Stratégie 1: JSON-LD
  let jsonLdData = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdData) return;
    try {
      const parsed = JSON.parse($(el).contents().text());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const product = candidates.find((c) => c['@type'] === 'Product');
      if (product) jsonLdData = product;
    } catch (_) {
      /* ignore blocs JSON-LD invalides */
    }
  });

  if (jsonLdData) {
    const offer = Array.isArray(jsonLdData.offers) ? jsonLdData.offers[0] : jsonLdData.offers;
    const price = offer ? parseFloat(offer.price) : null;
    if (price) {
      return {
        articleNumber: jsonLdData.sku || jsonLdData.mpn || extractArticleNumberFallback($),
        name: jsonLdData.name || $('h1').first().text().trim(),
        price,
        currency: (offer && offer.priceCurrency) || 'MAD',
        unitNote: null,
        imageUrl: jsonLdData.image || null,
        method: 'json-ld',
      };
    }
  }

  // Stratégie 2: fallback regex sur le texte brut (format observé: "19,90DH")
  const bodyText = $('body').text();
  const priceMatch = bodyText.match(/(\d[\d\s]*,\d{2})\s*DH(\/[^\s]+)?/);
  const articleNumber = extractArticleNumberFallback($);

  if (priceMatch) {
    const price = parseFloat(priceMatch[1].replace(/\s/g, '').replace(',', '.'));
    return {
      articleNumber,
      name: $('h1').first().text().trim(),
      price,
      currency: 'MAD',
      unitNote: priceMatch[2] || null,
      imageUrl: $('meta[property="og:image"]').attr('content') || null,
      method: 'regex-fallback',
    };
  }

  // Rien n'a fonctionné : on renvoie la raison précise pour le diagnostic (au lieu de juste null)
  let failReason = 'unknown';
  if (/captcha|access denied|blocked|are you human/i.test(bodyText)) failReason = 'blocked';
  else if (!articleNumber) failReason = 'no-article-number';
  else if (!priceMatch) failReason = 'no-price-found';
  return { failReason, bodyLength: bodyText.length };
}

function extractArticleNumberFallback($) {
  const text = $('body').text();
  const m = text.match(/Article number\s*([\d.\s]{8,})/i) || text.match(/Numéro d'article\s*([\d.\s]{8,})/i);
  return m ? m[1].trim() : null;
}

async function scrapeProduct(url, categoryName) {
  let html;
  try {
    html = await getHtml(url);
  } catch (err) {
    return { failReason: 'http-error: ' + (err.code || err.message) };
  }
  const data = parseProductPage(html, url);
  if (!data || !data.articleNumber || !data.price) {
    return { failReason: (data && data.failReason) || 'unknown' };
  }
  return { ...data, url, categoryName: categoryName || null };
}

// Insère/actualise un produit + n'ajoute une ligne d'historique QUE si le prix a changé
function upsertProduct({ articleNumber, name, url, price, currency, unitNote, imageUrl, categoryName }) {
  const existing = db.prepare('SELECT * FROM products WHERE article_number = ?').get(articleNumber);

  if (!existing) {
    db.prepare(
      `INSERT INTO products (article_number, name, slug_url, image_url, current_price, currency, unit_note, category, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(articleNumber, name, url, imageUrl, price, currency, unitNote, categoryName);
    db.prepare(
      `INSERT INTO price_history (article_number, price, currency) VALUES (?, ?, ?)`
    ).run(articleNumber, price, currency);
    return { isNew: true, priceChanged: true };
  }

  const priceChanged = existing.current_price !== price;
  db.prepare(
    `UPDATE products SET name=?, slug_url=?, image_url=?, current_price=?, currency=?, unit_note=?, category=COALESCE(?, category), last_checked_at=datetime('now'), is_active=1
     WHERE article_number=?`
  ).run(name, url, imageUrl, price, currency, unitNote, categoryName, articleNumber);

  if (priceChanged) {
    db.prepare(`INSERT INTO price_history (article_number, price, currency) VALUES (?, ?, ?)`).run(
      articleNumber,
      price,
      currency
    );
  }

  return { isNew: false, priceChanged };
}

// Rafraîchissement rapide : revisite directement les produits déjà connus (via leur URL
// enregistrée en base) sans refaire le crawl complet des catégories. Beaucoup plus rapide
// pour un usage quotidien — la découverte complète (nouveaux produits) est faite séparément.
async function refreshKnownProducts() {
  const runStart = db.prepare(`INSERT INTO scrape_runs (status) VALUES ('running')`).run();
  const runId = runStart.lastInsertRowid;

  const known = db
    .prepare(`SELECT article_number, slug_url, category FROM products WHERE is_active = 1`)
    .all();

  let productsSeen = 0;
  let pricesChanged = 0;
  let productsFailed = 0;

  db.prepare(`UPDATE scrape_runs SET products_found=? WHERE id=?`).run(known.length, runId);
  console.log(`=== Rafraîchissement rapide de ${known.length} produits connus ===`);

  try {
    for (const p of known) {
      try {
        const data = await scrapeProduct(p.slug_url, p.category);
        if (data && data.articleNumber) {
          const { priceChanged } = upsertProduct({
            articleNumber: data.articleNumber,
            name: data.name,
            url: data.url,
            price: data.price,
            currency: data.currency,
            unitNote: data.unitNote,
            imageUrl: data.imageUrl,
            categoryName: data.categoryName,
          });
          productsSeen++;
          if (priceChanged) pricesChanged++;
        } else {
          productsFailed++;
        }
      } catch (err) {
        productsFailed++;
        console.error(`[refresh] erreur sur ${p.slug_url}: ${err.message}`);
      }

      if ((productsSeen + productsFailed) % 10 === 0) {
        db.prepare(
          `UPDATE scrape_runs SET products_seen=?, prices_changed=?, products_failed=? WHERE id=?`
        ).run(productsSeen, pricesChanged, productsFailed, runId);
      }

      await sleep(300);
    }

    db.prepare(
      `UPDATE scrape_runs SET finished_at=datetime('now'), products_seen=?, products_new=0, prices_changed=?, products_failed=?, status='done' WHERE id=?`
    ).run(productsSeen, pricesChanged, productsFailed, runId);

    console.log(`=== Rafraîchissement terminé: ${productsSeen} ok, ${pricesChanged} prix changés, ${productsFailed} échecs ===`);
  } catch (err) {
    db.prepare(`UPDATE scrape_runs SET finished_at=datetime('now'), status=? WHERE id=?`).run(
      `error: ${err.message}`,
      runId
    );
    throw err;
  }
}

async function runFullScrape() {
  const runStart = db
    .prepare(`INSERT INTO scrape_runs (status) VALUES ('running')`)
    .run();
  const runId = runStart.lastInsertRowid;

  let productsSeen = 0;
  let productsNew = 0;
  let pricesChanged = 0;
  let productsFailed = 0;
  const failReasonCounts = {};

  try {
    console.log('=== Découverte des produits (parcours des catégories) ===');
    const productUrls = await discoverAllProductUrls();
    console.log(`=== ${productUrls.length} produits uniques trouvés. Début du scraping des prix ===`);

    db.prepare(`UPDATE scrape_runs SET products_found=? WHERE id=?`).run(productUrls.length, runId);

    for (const { url, categoryName } of productUrls) {
      try {
        const data = await scrapeProduct(url, categoryName);
        if (data && data.articleNumber) {
          const { isNew, priceChanged } = upsertProduct({
            articleNumber: data.articleNumber,
            name: data.name,
            url: data.url,
            price: data.price,
            currency: data.currency,
            unitNote: data.unitNote,
            imageUrl: data.imageUrl,
            categoryName: data.categoryName,
          });
          productsSeen++;
          if (isNew) productsNew++;
          if (priceChanged) pricesChanged++;
        } else {
          productsFailed++;
          const reason = (data && data.failReason) || 'unknown';
          failReasonCounts[reason] = (failReasonCounts[reason] || 0) + 1;
          if (productsFailed <= 10 || productsFailed % 200 === 0) {
            console.warn(`[scrape] échec (${reason}) sur ${url} — total échecs: ${productsFailed}`);
          }
        }
      } catch (err) {
        productsFailed++;
        console.error(`[scrape] erreur sur ${url}: ${err.message}`);
      }

      // Progression en direct toutes les 5 fiches, visible depuis le dashboard
      if ((productsSeen + productsFailed) % 5 === 0) {
        db.prepare(
          `UPDATE scrape_runs SET products_seen=?, products_new=?, prices_changed=?, products_failed=? WHERE id=?`
        ).run(productsSeen, productsNew, pricesChanged, productsFailed, runId);
      }

      await sleep(300); // politesse envers le serveur
    }

    db.prepare(
      `UPDATE scrape_runs SET finished_at=datetime('now'), products_seen=?, products_new=?, prices_changed=?, products_failed=?, status='done' WHERE id=?`
    ).run(productsSeen, productsNew, pricesChanged, productsFailed, runId);

    console.log(`=== Terminé: ${productsSeen} vus, ${productsNew} nouveaux, ${pricesChanged} prix changés, ${productsFailed} échecs ===`);
    console.log('=== Répartition des échecs:', JSON.stringify(failReasonCounts), '===');
  } catch (err) {
    db.prepare(`UPDATE scrape_runs SET finished_at=datetime('now'), status=? WHERE id=?`).run(
      `error: ${err.message}`,
      runId
    );
    throw err;
  }
}

module.exports = { runFullScrape, refreshKnownProducts, scrapeProduct, discoverAllProductUrls, parseProductPage };
