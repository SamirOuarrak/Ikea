// server.js — API + planification du scraping quotidien + sert le frontend

const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const { runFullScrape, refreshKnownProducts } = require('./scraper');

// Au démarrage, toute ligne encore "running" provient forcément d'un process tué par un
// redéploiement précédent (un vrai run en cours mourrait avec le process). On les marque
// comme interrompues pour ne pas fausser l'affichage ni bloquer un nouveau lancement.
db.prepare(`UPDATE scrape_runs SET status='interrupted', finished_at=datetime('now') WHERE status='running'`).run();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// ---------- PRODUITS (liste + filtres + tri) ----------
app.get('/api/products', (req, res) => {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const minPrice = req.query.minPrice ? parseFloat(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice ? parseFloat(req.query.maxPrice) : null;
  const promoOnly = req.query.promoOnly === 'true';
  const sort = req.query.sort || 'recent';
  const limit = Math.min(parseInt(req.query.limit) || 60, 300);
  const offset = parseInt(req.query.offset) || 0;

  const where = ['p.is_active = 1'];
  const params = [];

  if (q) {
    where.push('p.name LIKE ?');
    params.push(`%${q}%`);
  }
  if (category) {
    where.push('p.category = ?');
    params.push(category);
  }
  if (minPrice !== null) {
    where.push('p.current_price >= ?');
    params.push(minPrice);
  }
  if (maxPrice !== null) {
    where.push('p.current_price <= ?');
    params.push(maxPrice);
  }

  const sortMap = {
    recent: 'p.last_checked_at DESC',
    price_asc: 'p.current_price ASC',
    price_desc: 'p.current_price DESC',
    name: 'p.name ASC',
    biggest_drop: 'price_change_pct ASC',
  };
  const orderBy = sortMap[sort] || sortMap.recent;

  // previous_price (7 derniers jours) calculé pour permettre le tri "plus grosse baisse"
  // et le filtre "promo uniquement"
  let sql = `
    SELECT p.*,
      (SELECT price FROM price_history ph
       WHERE ph.article_number = p.article_number AND ph.checked_at < datetime('now', '-7 days')
       ORDER BY ph.checked_at DESC LIMIT 1) AS previous_price_7d,
      CASE WHEN (SELECT price FROM price_history ph
                 WHERE ph.article_number = p.article_number AND ph.checked_at < datetime('now', '-7 days')
                 ORDER BY ph.checked_at DESC LIMIT 1) IS NOT NULL
        THEN (p.current_price - (SELECT price FROM price_history ph
                 WHERE ph.article_number = p.article_number AND ph.checked_at < datetime('now', '-7 days')
                 ORDER BY ph.checked_at DESC LIMIT 1)) * 1.0 /
             (SELECT price FROM price_history ph
                 WHERE ph.article_number = p.article_number AND ph.checked_at < datetime('now', '-7 days')
                 ORDER BY ph.checked_at DESC LIMIT 1)
        ELSE NULL
      END AS price_change_pct
    FROM products p
    WHERE ${where.join(' AND ')}
  `;

  if (promoOnly) {
    sql = `SELECT * FROM (${sql}) t WHERE previous_price_7d IS NOT NULL AND price_change_pct < 0`;
  }

  sql += ` ORDER BY ${sort === 'biggest_drop' && !promoOnly ? 'price_change_pct ASC' : orderBy} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    console.error('Erreur /api/products:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historique de prix d'un produit précis
app.get('/api/products/:articleNumber/history', (req, res) => {
  const rows = db
    .prepare(`SELECT price, currency, checked_at FROM price_history WHERE article_number=? ORDER BY checked_at ASC`)
    .all(req.params.articleNumber);
  res.json(rows);
});

// Produits ajoutés récemment (nouveautés IKEA détectées par le crawler)
app.get('/api/products/new', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = db
    .prepare(
      `SELECT * FROM products WHERE is_active=1 AND first_seen_at >= datetime('now', ?) ORDER BY first_seen_at DESC`
    )
    .all(`-${days} days`);
  res.json(rows);
});

// Produits dont le prix a changé récemment
app.get('/api/products/price-drops', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = db
    .prepare(
      `SELECT p.article_number, p.name, p.slug_url, p.category, p.current_price, p.currency,
              (SELECT price FROM price_history ph
               WHERE ph.article_number = p.article_number AND ph.checked_at < datetime('now', ?)
               ORDER BY ph.checked_at DESC LIMIT 1) AS previous_price
       FROM products p WHERE p.is_active = 1`
    )
    .all(`-${days} days`)
    .filter((r) => r.previous_price !== null && r.previous_price !== r.current_price);
  res.json(rows);
});

// ---------- CATÉGORIES ----------
app.get('/api/categories', (req, res) => {
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) as count FROM products
       WHERE is_active=1 AND category IS NOT NULL
       GROUP BY category ORDER BY count DESC`
    )
    .all();
  res.json(rows);
});

// ---------- STATS / KPIs ----------
app.get('/api/stats', (req, res) => {
  const totalProducts = db.prepare(`SELECT COUNT(*) as c FROM products WHERE is_active=1`).get().c;
  const totalValue = db.prepare(`SELECT SUM(current_price) as s FROM products WHERE is_active=1`).get().s || 0;
  const avgPrice = db.prepare(`SELECT AVG(current_price) as a FROM products WHERE is_active=1`).get().a || 0;

  const changed7d = db
    .prepare(
      `SELECT p.current_price,
        (SELECT price FROM price_history ph WHERE ph.article_number = p.article_number
         AND ph.checked_at < datetime('now', '-7 days') ORDER BY ph.checked_at DESC LIMIT 1) AS prev
       FROM products p WHERE p.is_active = 1`
    )
    .all()
    .filter((r) => r.prev !== null && r.prev !== r.current_price);

  const drops7d = changed7d.filter((r) => r.current_price < r.prev).length;
  const rises7d = changed7d.filter((r) => r.current_price > r.prev).length;

  const newThisWeek = db
    .prepare(`SELECT COUNT(*) as c FROM products WHERE is_active=1 AND first_seen_at >= datetime('now', '-7 days')`)
    .get().c;

  const lastRun = db.prepare(`SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1`).get();

  res.json({
    totalProducts,
    totalValue: Math.round(totalValue),
    avgPrice: Math.round(avgPrice * 100) / 100,
    drops7d,
    rises7d,
    newThisWeek,
    lastRun,
  });
});

// ---------- ANALYSE : classement des plus grosses variations ----------
app.get('/api/analysis/top-movers', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const direction = req.query.direction === 'rise' ? 'rise' : 'drop';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  const rows = db
    .prepare(
      `SELECT p.article_number, p.name, p.slug_url, p.category, p.current_price, p.currency,
              (SELECT price FROM price_history ph
               WHERE ph.article_number = p.article_number AND ph.checked_at < datetime('now', ?)
               ORDER BY ph.checked_at DESC LIMIT 1) AS previous_price
       FROM products p WHERE p.is_active = 1`
    )
    .all(`-${days} days`)
    .filter((r) => r.previous_price !== null && r.previous_price !== r.current_price)
    .map((r) => ({ ...r, changePct: ((r.current_price - r.previous_price) / r.previous_price) * 100 }))
    .filter((r) => (direction === 'drop' ? r.changePct < 0 : r.changePct > 0))
    .sort((a, b) => (direction === 'drop' ? a.changePct - b.changePct : b.changePct - a.changePct))
    .slice(0, limit);

  res.json(rows);
});

// ---------- ANALYSE : tendance par catégorie (nb de baisses/hausses) ----------
app.get('/api/analysis/category-trends', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = db
    .prepare(
      `SELECT p.category, p.current_price,
        (SELECT price FROM price_history ph WHERE ph.article_number = p.article_number
         AND ph.checked_at < datetime('now', ?) ORDER BY ph.checked_at DESC LIMIT 1) AS prev
       FROM products p WHERE p.is_active = 1 AND p.category IS NOT NULL`
    )
    .all(`-${days} days`)
    .filter((r) => r.prev !== null && r.prev !== r.current_price);

  const byCategory = {};
  rows.forEach((r) => {
    if (!byCategory[r.category]) byCategory[r.category] = { category: r.category, drops: 0, rises: 0 };
    if (r.current_price < r.prev) byCategory[r.category].drops++;
    else byCategory[r.category].rises++;
  });

  res.json(Object.values(byCategory).sort((a, b) => b.drops + b.rises - (a.drops + a.rises)));
});

// ---------- EXPORT CSV ----------
app.get('/api/export/csv', (req, res) => {
  const rows = db.prepare(`SELECT * FROM products WHERE is_active=1 ORDER BY category, name`).all();
  const header = 'article_number,name,category,current_price,currency,first_seen_at,last_checked_at,url\n';
  const csvBody = rows
    .map((r) =>
      [
        r.article_number,
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${(r.category || '').replace(/"/g, '""')}"`,
        r.current_price,
        r.currency,
        r.first_seen_at,
        r.last_checked_at,
        r.slug_url,
      ].join(',')
    )
    .join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ikea-prix.csv"');
  res.send(header + csvBody);
});

// ---------- WATCHLIST / ALERTES ----------
app.get('/api/watchlist', (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.article_number, w.target_price, w.created_at,
              p.name, p.slug_url, p.current_price, p.currency, p.image_url
       FROM watchlist w JOIN products p ON p.article_number = w.article_number
       ORDER BY w.created_at DESC`
    )
    .all()
    .map((r) => ({ ...r, targetReached: r.current_price <= r.target_price }));
  res.json(rows);
});

app.post('/api/watchlist', (req, res) => {
  const { articleNumber, targetPrice } = req.body;
  if (!articleNumber || !targetPrice) {
    return res.status(400).json({ error: 'articleNumber et targetPrice requis' });
  }
  db.prepare(
    `INSERT INTO watchlist (article_number, target_price) VALUES (?, ?)
     ON CONFLICT(article_number) DO UPDATE SET target_price=excluded.target_price`
  ).run(articleNumber, targetPrice);
  res.json({ status: 'ok' });
});

app.delete('/api/watchlist/:articleNumber', (req, res) => {
  db.prepare(`DELETE FROM watchlist WHERE article_number=?`).run(req.params.articleNumber);
  res.json({ status: 'ok' });
});

// ---------- SCRAPING ----------
app.get('/api/scrape-runs', (req, res) => {
  res.json(db.prepare(`SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 20`).all());
});

app.post('/api/scrape/run-now', async (req, res) => {
  const running = db.prepare(`SELECT * FROM scrape_runs WHERE status='running' ORDER BY id DESC LIMIT 1`).get();
  if (running) {
    return res.status(409).json({ status: 'already-running', run: running });
  }
  res.json({ status: 'started' });
  try {
    await runFullScrape();
  } catch (err) {
    console.error('Erreur pendant le scrape manuel:', err.message);
  }
});

// Rafraîchissement rapide : revisite uniquement les produits déjà connus (pas de re-crawl
// des catégories). À utiliser au quotidien — beaucoup plus rapide que run-now.
app.post('/api/scrape/refresh-now', async (req, res) => {
  const running = db.prepare(`SELECT * FROM scrape_runs WHERE status='running' ORDER BY id DESC LIMIT 1`).get();
  if (running) {
    return res.status(409).json({ status: 'already-running', run: running });
  }
  res.json({ status: 'started' });
  try {
    await refreshKnownProducts();
  } catch (err) {
    console.error('Erreur pendant le rafraîchissement:', err.message);
  }
});

app.get('/health', (req, res) => res.status(200).send('ok'));

// Debug : diagnostic de l'extraction de prix pour une URL spécifique
app.get('/api/debug/extract-price', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url requis' });

  const axios = require('axios');
  const cheerio = require('cheerio');
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'fr-MA,fr;q=0.9',
      },
    });
    const html = response.data;
    const $ = cheerio.load(html);

    // Cherche tous les prix dans la page
    const bodyText = $('body').text();
    const allPrices = [];
    let match;
    const priceRegex = /(\d[\d\s]*,\d{2})\s*DH(\/[^\s]+)?/g;
    while ((match = priceRegex.exec(bodyText)) !== null) {
      const price = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
      allPrices.push({ price, match: match[0], index: match.index });
    }

    // Cherche le prix en JSON-LD
    let jsonLdPrice = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdPrice) return;
      try {
        const parsed = JSON.parse($(el).contents().text());
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const product = candidates.find((c) => c['@type'] === 'Product');
        if (product && product.offers) {
          const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          if (offer && offer.price) jsonLdPrice = { price: parseFloat(offer.price), source: 'json-ld' };
        }
      } catch (_) {}
    });

    // H1 et structure de la page
    const h1 = $('h1').first().text().trim();
    const priceSection = $('[class*="price"], [id*="price"]').html()?.substring(0, 200) || '(not found)';

    res.json({
      url,
      h1,
      jsonLdPrice,
      allPricesFoundInPage: allPrices.slice(0, 10),
      totalPricesFound: allPrices.length,
      priceSectionHtmlPreview: priceSection,
    });
  } catch (err) {
    res.json({ success: false, errorMessage: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`IKEA price tracker en écoute sur 0.0.0.0:${PORT}`);
});

// Planification :
// - Tous les jours à 6h00 : rafraîchissement rapide des produits déjà connus (prix à jour)
// - Tous les dimanches à 3h00 : découverte complète (nouveaux produits ajoutés par IKEA)
cron.schedule('0 6 * * *', async () => {
  console.log('Cron: rafraîchissement quotidien des prix');
  try {
    await refreshKnownProducts();
  } catch (err) {
    console.error('Cron: erreur pendant le rafraîchissement:', err.message);
  }
});

cron.schedule('0 3 * * 0', async () => {
  console.log('Cron: découverte hebdomadaire des nouveaux produits');
  try {
    await runFullScrape();
  } catch (err) {
    console.error('Cron: erreur pendant la découverte complète:', err.message);
  }
});
