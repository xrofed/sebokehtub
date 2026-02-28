const express = require('express');
const slugify = require('slugify');
const Video = require('../models/Video');

const router = express.Router();

function parsePagination(query) {
    const limitParam = parseInt(query.limit, 10);
    const pageParam = parseInt(query.page, 10);

    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 24;
    const page = Number.isFinite(pageParam) ? Math.max(pageParam, 1) : 1;
    const skip = (page - 1) * limit;

    return { limit, page, skip };
}

function keywordFromSlug(slug) {
    return decodeURIComponent(String(slug || '')).replace(/-/g, ' ').trim();
}

function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) {
            return res.status(400).json({
                success: false,
                message: 'Parameter q wajib diisi'
            });
        }

        const { limit, page, skip } = parsePagination(req.query);
        const safeKeyword = escapeRegex(q);
        const query = {
            $or: [
                { title: { $regex: safeKeyword, $options: 'i' } },
                { tags: { $regex: safeKeyword, $options: 'i' } },
                { categories: { $regex: safeKeyword, $options: 'i' } }
            ]
        };

        const [videos, total] = await Promise.all([
            Video.find(query)
                .select('title slug thumbnail duration duration_sec views categories tags upload_date created_at')
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Video.countDocuments(query)
        ]);

        res.json({
            success: true,
            q,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            data: videos
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Gagal mencari video'
        });
    }
});

router.get('/videos', async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req.query);

        const [videos, total] = await Promise.all([
            Video.find()
                .select('title slug thumbnail duration duration_sec views categories tags upload_date created_at')
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Video.countDocuments()
        ]);

        res.json({
            success: true,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            data: videos
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data video'
        });
    }
});

router.get('/videos/:slug', async (req, res) => {
    try {
        const video = await Video.findOne({ slug: req.params.slug })
            .select('title slug description embed_url thumbnail duration duration_sec views categories tags upload_date created_at')
            .lean();

        if (!video) {
            return res.status(404).json({
                success: false,
                message: 'Video tidak ditemukan'
            });
        }

        const categories = Array.isArray(video.categories) ? video.categories.filter(Boolean) : [];
        const tags = Array.isArray(video.tags) ? video.tags.filter(Boolean) : [];
        const recommendationQuery = {
            _id: { $ne: video._id }
        };

        if (categories.length > 0 || tags.length > 0) {
            recommendationQuery.$or = [];
            if (categories.length > 0) recommendationQuery.$or.push({ categories: { $in: categories } });
            if (tags.length > 0) recommendationQuery.$or.push({ tags: { $in: tags } });
        }

        let recommendations = await Video.aggregate([
            { $match: recommendationQuery },
            { $sample: { size: 6 } },
            {
                $project: {
                    title: 1,
                    slug: 1,
                    thumbnail: 1,
                    duration: 1,
                    duration_sec: 1,
                    views: 1,
                    categories: 1,
                    tags: 1,
                    upload_date: 1,
                    created_at: 1
                }
            }
        ]);

        if (recommendations.length < 6) {
            const excludedIds = [video._id, ...recommendations.map((item) => item._id)];
            const fallback = await Video.aggregate([
                { $match: { _id: { $nin: excludedIds } } },
                { $sample: { size: 6 - recommendations.length } },
                {
                    $project: {
                        title: 1,
                        slug: 1,
                        thumbnail: 1,
                        duration: 1,
                        duration_sec: 1,
                        views: 1,
                        categories: 1,
                        tags: 1,
                        upload_date: 1,
                        created_at: 1
                    }
                }
            ]);
            recommendations = recommendations.concat(fallback);
        }

        res.json({
            success: true,
            data: video,
            recommendations
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil detail video'
        });
    }
});

router.get('/categories', async (req, res) => {
    try {
        const categories = await Video.aggregate([
            { $unwind: '$categories' },
            { $match: { categories: { $type: 'string', $ne: '' } } },
            { $group: { _id: '$categories', totalVideos: { $sum: 1 } } },
            { $sort: { totalVideos: -1, _id: 1 } }
        ]);

        const data = categories.map((item) => ({
            name: item._id,
            slug: slugify(item._id, { lower: true, strict: true }),
            totalVideos: item.totalVideos
        }));

        res.json({
            success: true,
            total: data.length,
            data
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data kategori'
        });
    }
});

router.get('/tags', async (req, res) => {
    try {
        const tags = await Video.aggregate([
            { $unwind: '$tags' },
            { $match: { tags: { $type: 'string', $ne: '' } } },
            { $group: { _id: '$tags', totalVideos: { $sum: 1 } } },
            { $sort: { totalVideos: -1, _id: 1 } }
        ]);

        const data = tags.map((item) => ({
            name: item._id,
            slug: slugify(item._id, { lower: true, strict: true }),
            totalVideos: item.totalVideos
        }));

        res.json({
            success: true,
            total: data.length,
            data
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data tag'
        });
    }
});

router.get('/categories/:slug/videos', async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req.query);
        const keyword = keywordFromSlug(req.params.slug);
        const query = { categories: { $regex: keyword, $options: 'i' } };

        const [videos, total] = await Promise.all([
            Video.find(query)
                .select('title slug thumbnail duration duration_sec views categories tags upload_date created_at')
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Video.countDocuments(query)
        ]);

        res.json({
            success: true,
            category: req.params.slug,
            keyword,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            data: videos
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil video kategori'
        });
    }
});

router.get('/tags/:slug/videos', async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req.query);
        const keyword = keywordFromSlug(req.params.slug);
        const query = { tags: { $regex: keyword, $options: 'i' } };

        const [videos, total] = await Promise.all([
            Video.find(query)
                .select('title slug thumbnail duration duration_sec views categories tags upload_date created_at')
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Video.countDocuments(query)
        ]);

        res.json({
            success: true,
            tag: req.params.slug,
            keyword,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            data: videos
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil video tag'
        });
    }
});

module.exports = router;
