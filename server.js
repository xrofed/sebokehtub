require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const slugify = require('slugify');
const NodeCache = require('node-cache');

// Import Model & Utils
const Video = require('./models/Video');
const { isoToSeconds, formatDuration } = require('./utils/helpers');
const { uploadFromUrl } = require('./utils/r2Storage');

const app = express();
const myCache = new NodeCache({ stdTTL: 600 });

// ==========================================
// 1. DATABASE CONNECTION
// ==========================================
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/bokeptube')
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
// 2. CONFIGURATION & MIDDLEWARE
// ==========================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'bokeptube-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // 1 Jam
}));

// Fungsi helper untuk escape URL & XML content
function escapeXml(unsafe) {
    if (!unsafe) return '';
    return unsafe.replace(/&/g, '&amp;')
        .replace(/'/g, '&apos;')
        .replace(/"/g, '&quot;')
        .replace(/>/g, '&gt;')
        .replace(/</g, '&lt;');
}

// --- CACHE HELPER MIDDLEWARE ---
// Fungsi untuk mem-bypass database jika data ada di memori
const cacheMiddleware = (duration) => (req, res, next) => {
    // Skip cache jika user login (admin) atau bukan method GET
    if (req.session.isLoggedIn || req.method !== 'GET') {
        return next();
    }

    const key = '__express__' + req.originalUrl || req.url;
    const cachedBody = myCache.get(key);

    if (cachedBody) {
        return res.send(cachedBody);
    } else {
        res.sendResponse = res.send;
        res.send = (body) => {
            myCache.set(key, body, duration);
            res.sendResponse(body);
        };
        next();
    }
};

// ==========================================
// 3. GLOBAL SEO & VARIABLES MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
    const site_url = process.env.SITE_URL || 'http://localhost:3000';
    const site_name = process.env.SITE_NAME || "BokepTube";
    res.locals.site_url = site_url;
    res.locals.site_name = site_name;
    res.locals.logo_url = `${site_url}/uploads/logo.png`; // Fallback logo
    res.locals.favicon_url = `${site_url}/uploads/favicon.ico`;

    // Default SEO Values
    res.locals.current_title = `${site_name} - Streaming Video Bokep Terbaru`;
    res.locals.current_desc = `Nonton Bokep Terbaru 2025. ${site_name} adalah situs Bokep, Bokep Indo, Bokep Jepang, bokep bocil, bokep viral terlengkap dan terupdate. ${site_name}.`;
    res.locals.current_image = `${site_url}/uploads/default-poster.jpg`;
    res.locals.current_url = `${site_url}${req.originalUrl}`;

    // Default Robots & OG
    res.locals.robots_meta = "index, follow";
    res.locals.og_type = "website";
    res.locals.formatDuration = (sec) => {
        if (!sec) return "00:00";
        const date = new Date(0);
        date.setSeconds(sec);
        return sec > 3600 ? date.toISOString().substr(11, 8) : date.toISOString().substr(14, 5);
    };

    next();
});

// ==========================================
// 4. LEGACY REDIRECTS (PHP & Uploads)
// ==========================================
app.use((req, res, next) => {
    const path = req.path;
    const query = req.query;
    if (path.startsWith('/uploads/')) {
        const r2Domain = process.env.R2_PUBLIC_URL;
        if (r2Domain) {
            const cleanPath = path.replace('/uploads', '');
            return res.redirect(301, `${r2Domain}${cleanPath}`);
        }
    }

    // 2. Redirect File PHP Lama
    if (path === '/rss.php') return res.redirect(301, '/rss');
    if (path === '/sitemap.php') return res.redirect(301, '/sitemap.xml');
    if (path === '/rss-sitemap.php') return res.redirect(301, '/sitemap-video.xml');
    if (path === '/index.php') {
        const q = query.page ? `?page=${query.page}` : '';
        return res.redirect(301, `/${q}`);
    }
    if (path === '/rss-by-category.php') {
        const slug = query.slug || query.category;
        if (slug) return res.redirect(301, `/rss/category/${slug.replace(/ /g, '-')}`);
        return res.redirect(301, '/rss');
    }

    next();
});

// ==========================================
// 5. FRONTEND ROUTES (Cached)
// ==========================================

// --- HOME PAGE (Cache 5 Menit) ---
app.get('/', cacheMiddleware(300), async (req, res) => {
    try {
        const limit = 24;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;

        const videos = await Video.find().sort({ created_at: -1 }).skip(skip).limit(limit);
        const totalVideos = await Video.countDocuments();
        const totalPages = Math.ceil(totalVideos / limit);
        const page_label = page > 1 ? ` - Halaman ${page}` : "";

        res.render('index', {
            videos, currentPage: page, totalPages, totalVideos,
            current_title: `${res.locals.site_name}${page_label} | Nonton Bokep Bocil Terbaru, Bokep Chindo, Bokep Colmek, Bokep Hijab - Bokep Indo Terbaru`,
            current_desc: `Nonton bokep bocil terbaru, bokep chindo terbaik, bokep bocil smp, bokep hijab, bokep bocil colmek dan segudang bokep update terbaru setiap harinya.${page_label}`,
            current_image: `${res.locals.site_url}/og-image.jpg`
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// --- SINGLE VIDEO (Cache 1 Jam) ---
app.get('/video/:slug', cacheMiddleware(3600), async (req, res) => {
    try {
        Video.updateOne({ slug: req.params.slug }, { $inc: { views: 1 } }).exec();

        const video = await Video.findOne({ slug: req.params.slug });
        if (!video) {
            return res.status(404).render('404', {
                current_title: "Video Tidak Ditemukan",
                no_index: true
            });
        }

        const related = await Video.aggregate([{ $sample: { size: 8 } }]);
        const embed_url_full = `https://round-wave-fbe6.gordon96376-f42.workers.dev/?url=https:${video.embed_url}`;
        const meta_image = video.thumbnail.startsWith('http') ? video.thumbnail : `${res.locals.site_url}/${video.thumbnail}`;

        // Format tanggal untuk SEO
        const uploadDate = new Date(video.upload_date);
        const formattedDate = uploadDate.toISOString().replace('Z', '+07:00');

        // Deskripsi dengan durasi
        const durationText = video.duration_sec ? `${video.duration_sec} detik` : '60 detik';
        const seoDescription = `Bokep Indo ${video.title} dengan durasi ${durationText}. Nonton videonya hanya disini secara gratis tanpa iklan. ${res.locals.site_name} menyediakan koleksi video ${video.categories ? video.categories.join(', ') : 'bokep terbaru'}. Update setiap hari.`;

        // Kategori untuk section
        const categories = video.categories && video.categories.length > 0 ?
            video.categories : ['Bokep Terbaru'];

        // Tag untuk meta
        const seoTags = video.tags || [];

        // Section untuk schema (gabungkan kategori dengan defaults)
        const schemaSections = [...categories, 'Bokep Indo', 'Bokep Viral', 'Bokep Terbaru'];

        // Data lengkap untuk meta tags
        const seoData = {
            // Meta dasar
            seo_title: `${video.title} | ${res.locals.site_name}`,
            seo_description: seoDescription,
            seo_canonical: `${res.locals.site_url}/video/${video.slug}`,

            // Open Graph
            og_type: "article",
            og_image: meta_image,
            og_image_width: 854,
            og_image_height: 480,
            og_date: formattedDate,

            // Twitter
            twitter_card: "summary_large_image",
            twitter_site: `@${res.locals.site_name}`,
            twitter_creator: "@" + res.locals.site_name,
            twitter_image: meta_image,

            // Article tags
            article_tags: seoTags,
            article_section: categories[0] || 'Bokep Terbaru',

            // Schema.org
            schema_publisher_name: res.locals.site_name,
            schema_publisher_sameAs: [`https://twitter.com/${res.locals.site_name}`],
            schema_author_name: res.locals.site_name,
            schema_author_url: `${res.locals.site_url}/author/${encodeURIComponent(res.locals.site_name)}/`,
            schema_author_image: "https://secure.gravatar.com/avatar/ab04442537d717b73fab19403a00c802db3e20af6389304690fb313b5c0ae3ba?s=96&d=mm&r=g",
            schema_sections: schemaSections,
            schema_date: formattedDate,

            // Data tambahan untuk header.ejs
            current_title: `${video.title} | ${res.locals.site_name}`,
            current_desc: seoDescription,
            current_image: meta_image,
            current_url: `${res.locals.site_url}/video/${video.slug}`,
            og_type: "article",
            twitter_card: "summary_large_image"
        };

        res.render('single', {
            video,
            related,
            embed_url_full,
            formatDuration: res.locals.formatDuration,
            ...seoData  // Spread semua data SEO ke template
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// --- SEARCH (Cache 10 Menit) ---
app.get('/search', cacheMiddleware(600), async (req, res) => {
    try {
        const q = req.query.q || '';
        const query = {
            $or: [
                { title: { $regex: q, $options: 'i' } },
                { tags: { $regex: q, $options: 'i' } }
            ]
        };

        const videos = await Video.find(query).sort({ created_at: -1 }).limit(24);

        res.render('search', {
            videos, q,
            current_title: `Pencarian: ${q} | ${res.locals.site_name}`,
            no_index: true
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// --- TAGS (Cache 30 Menit) ---
app.get('/tag/:tag', cacheMiddleware(1800), async (req, res) => {
    try {
        const tagSlug = req.params.tag;
        const display_tag = tagSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const limit = 24;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        const page_label = page > 1 ? ` - Halaman ${page}` : "";

        const query = { tags: { $regex: tagSlug.replace(/-/g, ' '), $options: 'i' } };
        const videos = await Video.find(query).sort({ created_at: -1 }).skip(skip).limit(limit);
        const totalVideos = await Video.countDocuments(query);
        const totalPages = Math.ceil(totalVideos / limit);

        // SEO Description untuk tag
        const seoDescription = `Kumpulan video ${display_tag} dengan berbagai jenis adegan. Koleksi ${display_tag} terlengkap. Update terbaru setiap hari. Nonton video ${display_tag} gratis tanpa iklan di ${res.locals.site_name}.`;

        res.render('tags', {
            videos, display_tag, tagSlug, currentPage: page, totalPages, totalVideos,
            current_title: `${display_tag}${page_label} | ${res.locals.site_name}`,
            current_desc: seoDescription + page_label,  // Gunakan description SEO
            seo_description: seoDescription  // Tambahkan untuk template
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// --- CATEGORY (Cache 30 Menit) ---
app.get('/category/:slug', cacheMiddleware(1800), async (req, res) => {
    try {
        const categorySlug = req.params.slug;
        const display_cat = categorySlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

        const limit = 24;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        const page_label = page > 1 ? ` - Halaman ${page}` : "";
        const query = { categories: { $regex: categorySlug.replace(/-/g, ' '), $options: 'i' } };
        const videos = await Video.find(query).sort({ created_at: -1 }).skip(skip).limit(limit);
        const totalVideos = await Video.countDocuments(query);
        const totalPages = Math.ceil(totalVideos / limit);

        // SEO Description untuk kategori
        const seoDescription = `Kumpulan ${display_cat} dengan berbagai jenis adegan. Koleksi ${display_cat} terlengkap. Update terbaru setiap hari. Nonton ${display_cat} gratis tanpa iklan di ${res.locals.site_name}.`;

        res.render('category', {
            videos, display_cat, categorySlug, currentPage: page, totalPages, totalVideos,
            rss_category_slug: categorySlug,
            current_title: `${display_cat}${page_label} | ${res.locals.site_name}`,
            current_desc: seoDescription + page_label,  // Gunakan description SEO
            seo_description: seoDescription  // Tambahkan untuk template
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// ==========================================
// 7. SITEMAP & RSS FEED ROUTES (NO CACHE)
// ==========================================

// 1. Main RSS Feed
app.get('/rss', async (req, res) => {
    try {
        const site_url = process.env.SITE_URL || 'http://localhost:3000'; // Pastikan site_url terdefinisi
        const limit = 50;

        const videos = await Video.find().sort({ created_at: -1 }).limit(limit);
        const lastBuildDate = new Date().toUTCString();

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
    <channel>
        <title>${res.locals.site_name} - Video Terbaru</title>
        <link>${site_url}</link>
        <description>Nonton video viral terbaru di ${res.locals.site_name}</description>
        <language>id-ID</language>
        <lastBuildDate>${lastBuildDate}</lastBuildDate>
        <atom:link href="${site_url}/rss" rel="self" type="application/rss+xml" />`;

        videos.forEach(vid => {
            const videoLink = `${site_url}/video/${vid.slug}`;

            // Perbaikan logika thumbnail
            let thumbUrl = `${site_url}/uploads/default-poster.jpg`;
            if (vid.thumbnail) {
                thumbUrl = vid.thumbnail.startsWith('http') ? vid.thumbnail : `${site_url}/${vid.thumbnail}`;
            }

            // Pastikan formatDuration tersedia. Jika menggunakan res.locals:
            const duration = res.locals.formatDuration ? res.locals.formatDuration(vid.duration_sec) : vid.duration;

            xml += `
        <item>
            <title><![CDATA[${vid.title}]]></title>
            <link>${videoLink}</link>
            <guid isPermaLink="true">${videoLink}</guid>
            <description><![CDATA[
                <img src="${thumbUrl}" width="320" height="180" style="object-fit:cover;" /><br/>
                <p>${(vid.description || '').substring(0, 300)}...</p>
                <p><strong>Durasi:</strong> ${duration} | <strong>Views:</strong> ${vid.views || 0}</p>
            ]]></description>
            <media:content url="${thumbUrl}" medium="image">
                <media:title type="plain"><![CDATA[${vid.title}]]></media:title>
            </media:content>
            <pubDate>${new Date(vid.created_at).toUTCString()}</pubDate>
        </item>`;
        });

        xml += `
    </channel>
</rss>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 2. RSS by Category
app.get('/rss/category/:slug', async (req, res) => {
    try {
        const site_url = process.env.SITE_URL || 'http://localhost:3000'; // Pastikan site_url terdefinisi
        const categorySlug = req.params.slug;
        const categoryName = categorySlug.replace(/-/g, ' ');

        const videos = await Video.find({
            categories: { $regex: categoryName, $options: 'i' }
        }).sort({ created_at: -1 }).limit(30);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
    <channel>
        <title>${res.locals.site_name} Kategori: ${categoryName}</title>
        <link>${site_url}</link>
        <description>Feed terbaru dari kategori ${categoryName}</description>
        <language>id-ID</language>
        <atom:link href="${site_url}/rss/category/${categorySlug}" rel="self" type="application/rss+xml" />`;

        videos.forEach(vid => {
            let thumbUrl = `${site_url}/uploads/default-poster.jpg`;
            if (vid.thumbnail) {
                thumbUrl = vid.thumbnail.startsWith('http') ? vid.thumbnail : `${site_url}/${vid.thumbnail}`;
            }

            xml += `
        <item>
            <title><![CDATA[${vid.title}]]></title>
            <link>${site_url}/video/${vid.slug}</link>
            <guid>${site_url}/video/${vid.slug}</guid>
            <description><![CDATA[
                <img src="${thumbUrl}" width="320" /><br/>
                ${(vid.description || '').substring(0, 200)}...
            ]]></description>
            <pubDate>${new Date(vid.created_at).toUTCString()}</pubDate>
        </item>`;
        });

        xml += `
    </channel>
</rss>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 3. Video Sitemap (Google)
app.get('/sitemap-video.xml', async (req, res) => {
    try {
        const site_url = process.env.SITE_URL || 'http://localhost:3000'; // Pastikan site_url terdefinisi

        const videos = await Video.find()
            .select('title slug description thumbnail duration_sec tags created_at embed_url')
            .sort({ created_at: -1 })
            .limit(1000);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
    <url>
        <loc>${site_url}/</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>`;

        videos.forEach(vid => {
            const pageUrl = `${site_url}/video/${vid.slug}`;

            let thumbUrl = `${site_url}/uploads/default-poster.jpg`;
            if (vid.thumbnail) {
                thumbUrl = vid.thumbnail.startsWith('http') ? vid.thumbnail : `${site_url}/${vid.thumbnail}`;
            }

            // Escape URL thumbnail dan pageUrl
            const safeThumbUrl = escapeXml(thumbUrl);
            const safePageUrl = escapeXml(pageUrl);

            const embedUrlFull = `https:${vid.embed_url}`;
            const playerLoc = `https://round-wave-fbe6.gordon96376-f42.workers.dev/?url=${encodeURIComponent(embedUrlFull)}`;
            const safePlayerLoc = escapeXml(playerLoc);

            let videoTags = '';
            if (vid.tags && vid.tags.length > 0) {
                vid.tags.slice(0, 32).forEach(tag => {
                    // Gunakan CDATA untuk tag
                    videoTags += `<video:tag><![CDATA[${tag}]]></video:tag>`;
                });
            }

            // Gunakan CDATA untuk title dan description
            xml += `
    <url>
        <loc>${safePageUrl}</loc>
        <lastmod>${new Date(vid.created_at).toISOString()}</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
        <video:video>
            <video:thumbnail_loc>${safeThumbUrl}</video:thumbnail_loc>
            <video:title><![CDATA[${vid.title}]]></video:title>
            <video:description><![CDATA[${(vid.description || '').substring(0, 2000)}]]></video:description>
            <video:player_loc allow_embed="yes" autoplay="ap=1">${safePlayerLoc}</video:player_loc>
            <video:duration>${Math.round(vid.duration_sec || 0)}</video:duration>
            <video:publication_date>${new Date(vid.created_at).toISOString()}</video:publication_date>
            <video:family_friendly>no</video:family_friendly>
            <video:uploader info="${site_url}">${res.locals.site_name}</video:uploader>
            ${videoTags}
        </video:video>
    </url>`;
        });

        xml += `
</urlset>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ==========================================
// 1. SITEMAP INDEX (INDUK)
// ==========================================
app.get('/sitemap.xml', async (req, res) => {
    try {
        const site_url = process.env.SITE_URL || 'http://localhost:3000';
        const limit = 300; // Batas URL per file sitemap anak

        // Hitung total halaman yang dibutuhkan
        const totalVideos = await Video.countDocuments();
        const totalPages = Math.ceil(totalVideos / limit);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

        // Loop untuk membuat link ke sitemap-video-1.xml, sitemap-video-2.xml, dst.
        // Jika video 0, tetap buat 1 halaman agar tidak error 404
        const loopCount = totalPages === 0 ? 1 : totalPages;

        for (let i = 1; i <= loopCount; i++) {
            xml += `
    <sitemap>
        <loc>${site_url}/sitemap-video${i}.xml</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
    </sitemap>`;
        }

        xml += `</sitemapindex>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);

    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating sitemap index');
    }
});

// ==========================================
// 2. SITEMAP VIDEO PER HALAMAN (DINAMIS)
// ==========================================
app.get('/sitemap-video:page.xml', async (req, res) => {
    try {
        const site_url = process.env.SITE_URL || 'http://localhost:3000';
        const page = parseInt(req.params.page) || 1;
        const limit = 300;
        const skip = (page - 1) * limit;

        // Ambil data video sesuai halaman (Pagination)
        // Gunakan .lean() agar query cepat dan hemat memori
        const videos = await Video.find()
            .select('slug upload_date title thumbnail created_at')
            .sort({ created_at: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        // Jika halaman bukan 1 dan tidak ada video, return 404
        if (videos.length === 0 && page > 1) {
            return res.status(404).send('Sitemap page not found');
        }

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" 
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`;

        // ---------------------------------------------------------
        // LOGIKA KHUSUS HALAMAN 1 (Home, Categories, Tags)
        // ---------------------------------------------------------
        if (page === 1) {
            const today = new Date().toISOString().split('T')[0];

            // A. Tambahkan Homepage
            xml += `
    <url>
        <loc>${site_url}/</loc>
        <lastmod>${today}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>`;

            // B. Tambahkan Categories (Unik)
            const categories = await Video.distinct('categories');
            categories.forEach(cat => {
                if (cat) {
                    const safeSlug = cleanSlug(cat);
                    const catUrl = escapeXml(`${site_url}/category/${safeSlug}`);
                    xml += `
    <url>
        <loc>${catUrl}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.9</priority>
    </url>`;
                }
            });

            // C. Tambahkan Tags (Unik)
            const tags = await Video.distinct('tags');
            tags.forEach(tag => {
                if (tag) {
                    const safeSlug = cleanSlug(tag);
                    const tagUrl = escapeXml(`${site_url}/tag/${safeSlug}`);
                    xml += `
    <url>
        <loc>${tagUrl}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.9</priority>
    </url>`;
                }
            });
        }

        // ---------------------------------------------------------
        // LOGIKA VIDEO LIST (Semua Halaman)
        // ---------------------------------------------------------
        videos.forEach(vid => {
            // 1. Siapkan URL Video (Escape XML untuk keamanan)
            const rawVideoUrl = `${site_url}/video/${vid.slug}`;
            const videoUrl = escapeXml(rawVideoUrl);

            // 2. Siapkan URL Thumbnail
            let rawThumbUrl = `${site_url}/uploads/default-poster.jpg`;
            if (vid.thumbnail) {
                // Cek apakah thumbnail link absolut (http) atau relatif
                rawThumbUrl = vid.thumbnail.startsWith('http')
                    ? vid.thumbnail
                    : `${site_url}/${vid.thumbnail}`;
            }
            const thumbUrl = escapeXml(rawThumbUrl);

            // 3. Format Tanggal
            const date = new Date(vid.upload_date || vid.created_at || Date.now()).toISOString().split('T')[0];

            // 4. Render XML Item
            // PENTING: Gunakan CDATA untuk Title agar karakter seperti "&" tidak bikin error
            xml += `
    <url>
        <loc>${videoUrl}</loc>
        <lastmod>${date}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
        <image:image>
            <image:loc>${thumbUrl}</image:loc>
            <image:title><![CDATA[${vid.title}]]></image:title>
        </image:image>
    </url>`;
        });

        xml += `</urlset>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);

    } catch (err) {
        console.error('Sitemap Error:', err);
        res.status(500).send('Error generating video sitemap page');
    }
});


// ==========================================
// 7. ADMIN & SCRAPER ROUTES (No Cache)
// ==========================================
app.get('/admin/login', (req, res) => res.render('login', { error: null }));
app.post('/admin/login', (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        req.session.isLoggedIn = true;
        return res.redirect('/admin');
    }
    res.render('login', { error: 'Password Salah!' });
});
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});
app.get('/admin', (req, res) => {
    if (!req.session.isLoggedIn) return res.redirect('/admin/login');
    res.render('admin/admin'); // Sesuaikan path jika views/admin/admin.ejs
});

// API Scraper
app.post('/api/scrape', async (req, res) => {
    if (!req.session.isLoggedIn) return res.status(401).send('❌ Unauthorized');
    const { url } = req.body;
    if (!url) return res.send('❌ URL kosong!');

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
            }, timeout: 20000
        });

        const $ = cheerio.load(response.data);
        if ($('title').text().includes('Just a moment...')) return res.send('❌ Cloudflare Blocked');

        const title = $('meta[itemprop="name"]').attr('content') || $('title').text();
        if (!title) return res.send('❌ Judul Missing');

        const rawDuration = $('meta[itemprop="duration"]').attr('content') || 'PT0S';
        const durationSec = isoToSeconds(rawDuration);

        const existing = await Video.findOne({ title: title.trim() });
        if (existing) return res.send(`⚠️ Duplicate: ${title.substring(0, 20)}...`);

        const rawThumbnail = $('meta[itemprop="thumbnailUrl"]').attr('content');
        const slug = slugify(title, { lower: true, strict: true });
        const thumbUrl = await uploadFromUrl(rawThumbnail, slug);

        const newVideo = new Video({
            title: title.trim(), slug,
            description: $('meta[itemprop="description"]').attr('content') || '',
            embed_url: $('meta[itemprop="embedURL"]').attr('content') || '',
            thumbnail: thumbUrl, duration: rawDuration, duration_sec: durationSec,
            tags: $('a[href*="/tag/"]').map((i, el) => $(el).text().trim()).get(),
            categories: $('a[href*="/category/"]').map((i, el) => $(el).text().trim()).get(),
            upload_date: new Date()
        });

        await newVideo.save();

        // INVALIDATE CACHE (Hapus cache Homepage agar video baru muncul)
        myCache.del('__express__/' + '/');
        myCache.del('__express__/' + '/rss');

        res.send(`✅ Success: ${title.substring(0, 40)}`);
    } catch (err) {
        console.error(err);
        res.send(`❌ Error: ${err.message}`);
    }
});

// ==========================================
// 8. 404 HANDLER (Last Route)
// ==========================================
app.use(async (req, res) => {
    try {
        const randomVideos = await Video.aggregate([{ $sample: { size: 4 } }]);
        res.status(404).render('404', {
            videos: randomVideos,
            current_title: "Page Not Found",
            no_index: true
        });
    } catch (err) {
        res.status(404).render('404');
    }
});

// ==========================================
// 9. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
