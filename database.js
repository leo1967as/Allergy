import sqlite3 from 'sqlite3';
import fs from 'fs';
import csv from 'csv-parser';

const DB_FILE = './allergens.db';

// ฟังก์ชันสำหรับสร้างตาราง (เพิ่มคอลัมน์ function และ found_in)
function createTable(db) {
    db.run(`CREATE TABLE IF NOT EXISTS allergens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        keywords TEXT NOT NULL,
        function TEXT,
        found_in TEXT 
    )`, (err) => {
        if (err) console.error("❌ Error creating table: ", err.message);
        else {
            console.log("✅ Table 'allergens' is ready with new structure.");
            seedDataFromCSV(db);
        }
    });
}

// ฟังก์ชันสำหรับอ่านและป้อนข้อมูลจาก CSV (อัปเดตให้ตรงกับ 4 คอลัมน์)
function seedDataFromCSV(db) {
    const results = [];
    fs.createReadStream('./allergens.csv')
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        console.log(`ℹ️  Read ${results.length} records from CSV file.`);
        const insertSql = `INSERT OR IGNORE INTO allergens (name, keywords, function, found_in) VALUES (?, ?, ?, ?)`;
        
        db.serialize(() => {
            const stmt = db.prepare(insertSql);
            results.forEach((allergen) => {
                stmt.run(allergen.name, allergen.keywords, allergen.function, allergen.found_in);
            });
            stmt.finalize(() => {
                console.log(`🌱 Database is now seeded/updated from CSV.`);
            });
        });
      });
}

// // ลบไฟล์ DB เก่าทิ้งทุกครั้งที่เริ่มเซิร์ฟเวอร์เพื่อให้ข้อมูลอัปเดตเสมอ
// if (fs.existsSync(DB_FILE)) {
//     fs.unlinkSync(DB_FILE);
//     console.log('🗑️  Removed old database file. Will re-create from CSV.');
// }

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) console.error("❌ Error opening database: ", err.message);
    else {
        console.log("✅ Database connected successfully.");
        createTable(db);
    }
});



export default db;