const slugify = require('slugify');

exports.makeSlug = (text) => {
    return slugify(text, { lower: true, strict: true, trim: true });
};

// PERBAIKAN: Regex diperluas untuk menangkap Days (D), Hours (H), Minutes (M), Seconds (S)
// Format Input: "P0DT0H1M2S" -> 62 detik
exports.isoToSeconds = (isoString) => {
    if (!isoString || typeof isoString !== 'string') return 0;

    // Regex baru: Menangani P (Period), opsional Days (D), T (Time separator), opsional H, M, S
    const match = isoString.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);

    if (!match) return 0;

    const days = parseInt(match[1]) || 0;    // Group 1: Days
    const hours = parseInt(match[2]) || 0;   // Group 2: Hours
    const minutes = parseInt(match[3]) || 0; // Group 3: Minutes
    const seconds = parseInt(match[4]) || 0; // Group 4: Seconds

    // Konversi semua ke detik
    return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
};

exports.formatDuration = (seconds) => {
    if (!seconds) return "00:00";
    const date = new Date(0);
    date.setSeconds(seconds);
    const timeString = date.toISOString().substr(11, 8);
    return seconds >= 3600 ? timeString : timeString.substr(3);
};