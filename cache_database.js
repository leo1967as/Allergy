// cache_database.js (เวอร์ชันอัปเกรด - ค้นหาแบบ LIKE)
import sqlite3 from 'sqlite3';

const CACHE_DB_FILE = './cache.db';

const cacheDb = new sqlite3.Database(CACHE_DB_FILE, (err) => {
    if (err) {
        console.error("❌ Error opening cache database " + err.message);
    } else {
        console.log("✅ Cache Database connected successfully.");
        cacheDb.run(`CREATE TABLE IF NOT EXISTS ai_cache (
            query TEXT PRIMARY KEY,
            response TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("❌ Error creating cache table " + err.message);
            else console.log("✅ Table 'ai_cache' is ready.");
        });
    }
});

/**
 * ฟังก์ชันสำหรับค้นหา Cache (อัปเกรดให้ค้นหาแบบ LIKE)
 * @param {string} query คำค้นหาของผู้ใช้
 * @returns {Promise<object|null>} ผลลัพธ์ที่ถูกแปลงเป็น JSON object หรือ null
 */
export function findInCache(query) {
    return new Promise((resolve) => {
        // ป้องกันการค้นหาด้วยคำที่สั้นเกินไป
        const searchTerm = query.toLowerCase().trim();
        if (searchTerm.length < 2) {
            return resolve(null);
        }

        // --- ส่วนที่แก้ไข ---
        // 1. สร้าง term สำหรับค้นหาแบบ LIKE
        const likeTerm = `%${searchTerm}%`; 
        
        // 2. เปลี่ยนคำสั่ง SQL ให้ใช้ LIKE แทน =
        const sql = `SELECT response FROM ai_cache WHERE query LIKE ? LIMIT 1`;

        cacheDb.get(sql, [likeTerm], (err, row) => {
            if (err || !row) {
                resolve(null); // ถ้า error หรือไม่เจอ ก็คืนค่า null
            } else {
                console.log(`✅ พบ Cache ที่ใกล้เคียงสำหรับ: "${query}"`);
                resolve(JSON.parse(row.response));
            }
        });
        // ------------------
    });
}

/**
 * ฟังก์ชันสำหรับบันทึก Cache ใหม่ (ไม่มีการเปลี่ยนแปลง)
 * @param {string} query คำค้นหาของผู้ใช้
 * @param {object} response ผลลัพธ์จาก AI ที่เป็น Object
 */
export function saveToCache(query, response) {
    const responseString = JSON.stringify(response);
    const sql = `INSERT OR REPLACE INTO ai_cache (query, response) VALUES (?, ?)`;
    
    cacheDb.run(sql, [query.toLowerCase().trim(), responseString], function(err) {
        if (err) {
            console.error("❌ (Cache) Error saving to cache database:", err.message);
        } else {
            console.log(`💾 (Cache) บันทึก Cache สำหรับคำค้นหา "${query}" เรียบร้อย!`);
        }
    });
}