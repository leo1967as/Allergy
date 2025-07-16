// File: /api/index.js (สำหรับ Vercel - แก้ไขสมบูรณ์)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sqlite3 from 'sqlite3';
import csv from 'csv-parser';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = path.join('/tmp', 'allergens.db');
const CACHE_DB_PATH = path.join('/tmp', 'cache.db'); // <-- เพิ่ม Path สำหรับ Cache DB
let db , cacheDb;

const initializeMainDb = () => new Promise((resolve, reject) => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    const newDb = new sqlite3.Database(DB_PATH, (err) => {
        if (err) return reject(err);
        newDb.run(`CREATE TABLE allergens (name TEXT UNIQUE, keywords TEXT, function TEXT, found_in TEXT)`, (err) => {
            if (err) return reject(err);
            const csvPath = path.join(process.cwd(), 'allergens.csv');
            if (!fs.existsSync(csvPath)) return reject(new Error('allergens.csv not found'));
            
            fs.createReadStream(csvPath)
              .pipe(csv())
              .on('data', (row) => newDb.run(`INSERT OR IGNORE INTO allergens VALUES (?,?,?,?)`, [row.name, row.keywords, row.function, row.found_in]))
              .on('end', () => {
                  console.log('Main DB Initialized in /tmp.');
                  resolve(newDb);
              });
        });
    });
});

const ensureDbInitialized = async (req, res, next) => {
    try {
        if (!db || !db.isReady) {
            db = await initializeMainDb();
            db.isReady = true;
        }
        if (!cacheDb || !cacheDb.isReady) {
            cacheDb = await initializeCacheDb();
            cacheDb.isReady = true;
        }
    } catch (error) {
        console.error("Failed to initialize databases:", error);
        return res.status(500).json({ error: "Database initialization failed.", details: error.message });
    }
    next();
};

// --- ฟังก์ชันที่ขาดไป ถูกนำกลับมา ---
async function generateStructuredAnswer(context, question) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", generationConfig: { response_mime_type: "application/json" } });
    const prompt = `จาก Context: """${context}""" ให้วิเคราะห์ "${question}" และตอบกลับเป็น JSON object ที่มีโครงสร้างนี้: {"name": "...", "aliases": "...", "func": "...", "products": "..."}. ถ้าไม่เจอให้ใส่ "ไม่พบข้อมูล"`;
    try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error("❌ (Gemini) Error:", error);
        return { name: "ไม่สามารถประมวลผลได้", aliases: "-", func: "-", products: "-" };
    }
}
// --- เพิ่มฟังก์ชันสำหรับสร้างฐานข้อมูล Cache ---
const initializeCacheDb = () => new Promise((resolve, reject) => {
    const newCacheDb = new sqlite3.Database(CACHE_DB_PATH, (err) => {
        if (err) return reject(err);
        newCacheDb.run(`CREATE TABLE IF NOT EXISTS ai_cache (query TEXT PRIMARY KEY, response TEXT)`, (err) => {
            if (err) return reject(err);
            console.log('Cache DB Initialized in /tmp.');
            resolve(newCacheDb);
        });
    });
});

// --- API Endpoints ---

// --- Endpoint สำหรับ Live Search (เวอร์ชันแก้ไข Logic การค้นหา Cache) ---
app.post('/api/live-search', ensureDbInitialized, async (req, res) => {
    const { question } = req.body;
    if (!question || question.trim().length < 2) return res.json({ found: false });

    const searchTerm = question.toLowerCase().trim();
    const likeTerm = `%${searchTerm}%`;

    try {
        // ---- 1. ค้นหาใน DB หลักก่อน (แบบ LIKE) ----
        const dbResult = await new Promise((resolve, reject) => {
            const sql = `SELECT * FROM allergens WHERE keywords LIKE ? OR name LIKE ? LIMIT 1`;
            db.get(sql, [likeTerm, likeTerm], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });

        if (dbResult) {
            console.log(`✅ พบใน DB หลักสำหรับ: "${question}"`);
            return res.json({
                found: true,
                data: {
                    allergy_status: 'สารนี้อยู่ในฐานข้อมูลสารก่อภูมิแพ้ของเรา',
                    name: dbResult.name,
                    aliases: dbResult.keywords.replace(/,/g, ', '),
                    func: dbResult.function,
                    products: dbResult.found_in,
                    source: 'ฐานข้อมูลของเรา'
                }
            });
        }

        // ---- 2. ถ้าไม่เจอ ให้ค้นหาใน Cache (แบบ LIKE) ----
        const cacheResult = await new Promise((resolve, reject) => {
            const sql = `SELECT response FROM ai_cache WHERE query LIKE ? LIMIT 1`;
            cacheDb.get(sql, [likeTerm], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });

        if (cacheResult) {
            console.log(`✅ พบ Cache ที่ใกล้เคียงสำหรับ: "${question}"`);
            return res.json({ found: true, data: JSON.parse(cacheResult.response) });
        }

        // ---- 3. ถ้าไม่เจอในทั้งสองที่ ----
        console.log(`⚠️ ไม่พบทั้งใน DB และ Cache สำหรับ: "${question}"`);
        res.json({ found: false });

    } catch (error) {
        console.error("Live Search Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการค้นหา" });
    }
});

// --- Endpoint สำหรับค้นหาด้วย AI (และบันทึกลง Cache) ---
app.post('/api/ask-ai', ensureDbInitialized, async (req, res) => {
    const { question } = req.body;
    console.log(`\n🤖 AI Search สำหรับ: "${question}"`);

    try {
        const searchQuery = `${question} คืออะไร หน้าที่ การใช้ ประโยชน์ ชื่อทางเคมี`;
        const searchResults = await axios.get(`https://www.googleapis.com/customsearch/v1`, {
            params: { key: process.env.SEARCH_API_KEY, cx: process.env.SEARCH_ENGINE_ID, q: searchQuery, num: 3 }
        });
        const googleContext = searchResults.data.items?.map(item => `หัวข้อ:${item.title}\nเนื้อหา:${item.snippet}`).join('\n---\n') || "ไม่พบข้อมูล";
        
        const aiResult = await generateStructuredAnswer(googleContext, question);
        
        const finalResponse = {
            ...aiResult,
            source: 'ผลการค้นหาที่ถูกบันทึกไว้ (Cache)',
            allergy_status: 'ข้อมูลนี้เป็นเพียงสิ่งที่เคยค้นหาและบันทึกไว้'
        };

        // บันทึกลง Cache
        if (aiResult.name && aiResult.name !== "ไม่สามารถประมวลผลได้" && aiResult.name !== "ไม่พบข้อมูล") {
            const responseString = JSON.stringify(finalResponse);
            cacheDb.run(`INSERT OR REPLACE INTO ai_cache (query, response) VALUES (?, ?)`, [question.toLowerCase().trim(), responseString]);
            console.log(`💾 (Cache) บันทึก Cache สำหรับคำค้นหา "${question}" เรียบร้อย!`);
        }

        res.json(finalResponse);

    } catch (error) {
        console.error("AI Search Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการค้นหาด้วย AI" });
    }
});

app.get('/api/get-all-allergens', ensureDbInitialized, (req, res) => {
    const sql = `SELECT name, keywords FROM allergens ORDER BY name ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
        else res.json(rows);
    });
});

// --- Endpoint ใหม่! สำหรับลบ Cache ---
app.post('/api/delete-cache', ensureDbInitialized, async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: "Query is required to delete cache." });
    }

    const searchTerm = query.toLowerCase().trim();
    const sql = `DELETE FROM ai_cache WHERE query = ?`;

    cacheDb.run(sql, [searchTerm], function(err) {
        if (err) {
            console.error("❌ (Cache) Error deleting cache:", err.message);
            return res.status(500).json({ error: "Failed to delete cache." });
        }
        
        // this.changes จะบอกว่ามีแถวที่ถูกลบไปหรือไม่
        if (this.changes > 0) {
            console.log(`🗑️ (Cache) ลบ Cache สำหรับคำค้นหา "${searchTerm}" เรียบร้อย!`);
            res.json({ success: true, message: `Cache for "${searchTerm}" deleted.` });
        } else {
            res.json({ success: false, message: `No cache found for "${searchTerm}".` });
        }
    });
});

// Export a single handler for Vercel
export default app;