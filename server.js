/**
 * SEEP Pro V2 — API Server
 */
const app = require("./api/index");

const PORT = process.env.PORT || 3000;

if (require.main === module || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`\n==================================================`);
        console.log(`🚀 SEEP PRO API SERVER IS LIVE ON PORT ${PORT}!`);
        console.log(`URL: http://localhost:${PORT}`);
        console.log(`Admin Secret Key: BheemPhoto_Secret_2026!`);
        console.log(`==================================================\n`);
    });
}

module.exports = app;
