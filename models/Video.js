const mongoose = require('mongoose');

/**
 * Schema Video - Pengganti struktur tabel 'videos' di MySQL
 */
const videoSchema = new mongoose.Schema({
    // Judul video (wajib ada)
    title: { 
        type: String, 
        required: true,
        trim: true 
    },
    // Slug untuk URL SEO friendly (wajib unik)
    slug: { 
        type: String, 
        required: true, 
        unique: true 
    },
    // Deskripsi video (nl2br akan dihandle di view)
    description: { 
        type: String, 
        default: '' 
    },
    // URL Iframe dari sumber video
    embed_url: { 
        type: String, 
        default: '' 
    },
    // URL Thumbnail yang disimpan di Cloudflare R2
    thumbnail: { 
        type: String, 
        default: '' 
    },
    // Durasi dalam format string (misal: 10:30)
    duration: { 
        type: String, 
        default: '00:00' 
    },
    // Durasi dalam detik untuk sorting/logic
    duration_sec: { 
        type: Number, 
        default: 0 
    },
    // Jumlah penonton (pengganti logic update views)
    views: { 
        type: Number, 
        default: 0 
    },
    // Tanggal publikasi dari meta tag asli
    upload_date: { 
        type: Date, 
        default: Date.now 
    },
    // Array kategori (pengganti string koma di SQL)
    categories: [{ 
        type: String 
    }],
    // Array tags (pengganti string koma di SQL)
    tags: [{ 
        type: String 
    }],
    // Status Google Indexing API
    google_indexed: { 
        type: Boolean, 
        default: false 
    },
    // Metadata tambahan untuk tracking
    created_at: { 
        type: Date, 
        default: Date.now 
    }
}, {
    // Menambahkan createdAt dan updatedAt secara otomatis
    timestamps: true 
});

// Membuat index untuk pencarian agar lebih cepat (Pengganti LIKE di SQL)
videoSchema.index({ title: 'text', tags: 'text' });

module.exports = mongoose.model('Video', videoSchema);