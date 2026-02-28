const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const axios = require("axios");
const path = require("path");

const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

exports.uploadFromUrl = async (url, fileName) => {
    try {
        // Download gambar ke buffer (Pengganti get_html_curl di PHP)
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'utf-8');
        
        const ext = path.extname(url) || '.jpg';
        const key = `uploads/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${fileName}${ext}`;

        // Upload ke Cloudflare R2
        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: response.headers['content-type'],
        }));

        // Kembalikan Full URL R2
        return `${process.env.R2_PUBLIC_URL}/${key}`;
    } catch (error) {
        console.error("R2 Upload Error:", error.message);
        return null;
    }
};