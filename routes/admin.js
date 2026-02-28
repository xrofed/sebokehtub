const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');
const Video = require('../models/Video');
const { makeSlug, isoToSeconds } = require('../utils/helpers');

// Middleware Auth (Pengganti session check)
const auth = (req, res, next) => {
    if (req.session.isLoggedIn) return next();
    res.redirect('/admin/login');
};

// Login Logic
router.post('/login', (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        req.session.isLoggedIn = true;
        return res.redirect('/admin');
    }
    res.render('login', { error: 'Password salah!' });
});

// Scraper API
router.post('/api/scrape', auth, async (req, res) => {
    try {
        const { url } = req.body;
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);

        const title = $('meta[itemprop="name"]').attr('content') || $('title').text();
        const existing = await Video.findOne({ title });
        
        if (existing) return res.send(`⚠️ Sudah ada: ${title.substring(0, 30)}`);

        const newVideo = new Video({
            title,
            slug: makeSlug(title),
            description: $('meta[itemprop="description"]').attr('content'),
            embed_url: $('meta[itemprop="embedURL"]').attr('content'),
            thumbnail: $('meta[itemprop="thumbnailUrl"]').attr('content'),
            duration: $('meta[itemprop="duration"]').attr('content'),
            duration_sec: isoToSeconds($('meta[itemprop="duration"]').attr('content') || ''),
            tags: $('a[href*="/tag/"]').map((i, el) => $(el).text().trim()).get(),
            categories: $('a[href*="/category/"]').map((i, el) => $(el).text().trim()).get()
        });

        await newVideo.save();
        res.send(`✅ Berhasil: ${title}`);
    } catch (err) {
        res.status(500).send(`❌ Error: ${err.message}`);
    }
});

// Contoh Route Search (Ganti search.php)
app.get('/search', async (req, res) => {
    const q = req.query.q;
    const videos = await Video.find({ 
        $or: [
            { title: { $regex: q, $options: 'i' } },
            { tags: { $regex: q, $options: 'i' } }
        ]
    }).limit(24);
    
    res.render('search', { 
        videos, 
        q, 
        current_title: `Pencarian: ${q}`,
        no_index: true 
    });
});

// Contoh Route Category (Ganti category.php)
app.get('/category/:slug', async (req, res) => {
    const categoryName = req.params.slug.replace(/-/g, ' ');
    const videos = await Video.find({ 
        categories: { $regex: categoryName, $options: 'i' } 
    });
    res.render('category', { 
        videos, 
        display_cat: categoryName 
    });
});

module.exports = router;