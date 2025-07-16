// File: /api/index.js (สำหรับ Vercel)

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

// --- การจัดการฐานข้อมูลสำหรับ Vercel (สร้างในโฟลเดอร์ชั่วคราว /tmp) ---
const DB_PATH = path.join('/tmp', 'allergens.db');
let db;

// ฟังก์ชันสำหรับสร้างและ Seed ฐานข้อมูลหลัก
const initializeMainDb = () => new Promise((resolve, reject) => {
    // สร้าง DB ใหม่ทุกครั้งที่ฟังก์ชันถูกเรียก (Cold Start)
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    
    const newDb = new sqlite3.Database(DB_PATH, (err) => {
        if (err) return reject(err);
        
        newDb.run(`CREATE TABLE allergens (name TEXT UNIQUE, keywords TEXT, function TEXT, found_in TEXT)`, (err) => {
            if (err) return reject(err);

            fs.createReadStream(path.join(process.cwd(), 'allergens.csv'))
              .pipe(csv())
              .on('data', (row) => newDb.run(`INSERT OR IGNORE INTO allergens VALUES (?,?,?,?)`, [row.name, row.keywords, row.function, row.found_in]))
              .on('end', () => {
                  console.log('Main DB Initialized in /tmp.');
                  resolve(newDb);
              });
        });
    });
});

// Middleware เพื่อให้แน่ใจว่า DB พร้อมใช้งาน
const ensureDbInitialized = async (req, res, next) => {
    if (!db) {
        try {
            db = await initializeMainDb();
        } catch (error) {
            console.error("Failed to initialize database:", error);
            return res.status(500).json({ error: "Database initialization failed." });
        }
    }
    next();
};

// --- ฟังก์ชันค้นหาใน DB หลัก (ไม่มีการเปลี่ยนแปลง) ---
function searchLocalDatabase(question) {
    // ...โค้ดของฟังก์ชันนี้เหมือนเดิมทุกประการ...
    return new Promise((resolve, reject) => {
        if (!question || question.trim().length < 2) return resolve(null);
        const cleanQuestion = question.toLowerCase().replace(/[^a-z0-9\s-]/g, '');
        const terms = cleanQuestion.split(/\s+/).filter(term => term.length > 2);
        
        if (terms.length === 0) {
            const singleTermSql = `SELECT * FROM allergens WHERE keywords LIKE ? OR name LIKE ? LIMIT 1`;
            db.get(singleTermSql, [`%${cleanQuestion}%`, `%${cleanQuestion}%`], (err, row) => resolve(row || null));
            return;
        }

        const conditions = terms.map(() => `(keywords LIKE ? OR name LIKE ?)`).join(' AND ');
        const params = terms.flatMap(term => [`%${term}%`, `%${term}%`]);
        const sql = `SELECT * FROM allergens WHERE ${conditions} ORDER BY length(name) LIMIT 1`;
        
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

// --- ฟังก์ชันเรียก Gemini (ไม่มีการเปลี่ยนแปลง) ---
async function generateStructuredAnswer(context, question) {
    console.log('🤖 กำลังส่ง Prompt (แบบละเอียด) ไปให้ Gemini...');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: { response_mime_type: "application/json" }
    });
    const prompt = `คำสั่ง: คุณคือผู้เชี่ยวชาญด้านการวิเคราะห์และสรุปข้อมูลสารเคมี. เป้าหมาย: วิเคราะห์ข้อมูลทั้งหมดที่ให้มาเกี่ยวกับ "${question}" จาก Context ต่อไปนี้. Context: """${context}""" งานของคุณคือ: สังเคราะห์ข้อมูลจาก Context เพื่อสร้างผลลัพธ์เป็น JSON object ที่มีโครงสร้างตามนี้เท่านั้น: {"name": "ชื่อสารที่เป็นไปได้มากที่สุด", "aliases": "ชื่อแฝงหรือชื่ออื่นทั้งหมดที่พบ คั่นด้วยคอมม่า", "func": "สรุปหน้าที่หลักทั้งหมดที่พบ", "products": "สรุปผลิตภัณฑ์หรือสิ่งที่มักจะพบสารนี้ทั้งหมด คั่นด้วยคอมม่า"}. ข้อบังคับสำคัญ: 1. ห้ามคิดข้อมูลเองเด็ดขาด. 2. สำหรับแต่ละฟิลด์ ให้รวบรวมข้อมูลที่เกี่ยวข้องทั้งหมดจาก Context มาสรุป. 3. ถ้าไม่พบข้อมูลสำหรับฟิลด์ใดจริงๆ ให้ใส่ค่าเป็น "ไม่พบข้อมูลจากแหล่งข้อมูลที่ค้นหาได้"`;

    try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error("❌ (Gemini) Error:", error);
        return { name: "ไม่สามารถประมวลผลได้", aliases: "-", func: "-", products: "-" };
    }
}

// --- Endpoint ใหม่! สำหรับ Live Search ที่มี Logic การ Cache ---
// Endpoint สำหรับ Live Search
app.post('/api/live-search', ensureDbInitialized, async (req, res) => {
    const { question } = req.body;
    if (!question || question.trim().length < 2) return res.json({ found: false });

    const searchTerm = `%${question.toLowerCase().trim()}%`;
    const sql = `SELECT * FROM allergens WHERE keywords LIKE ? OR name LIKE ? LIMIT 1`;
    
    db.get(sql, [searchTerm, searchTerm], (err, row) => {
        if (err || !row) {
            res.json({ found: false });
        } else {
            res.json({
                found: true,
                data: {
                    allergy_status: 'สารนี้อยู่ในฐานข้อมูลสารก่อภูมิแพ้ของเรา',
                    name: row.name,
                    aliases: row.keywords.replace(/,/g, ', '),
                    func: row.function,
                    products: row.found_in,
                    source: 'ฐานข้อมูลของเรา'
                }
            });
        }
    });
});

// --- Endpoint สำหรับค้นหาด้วย AI (และบันทึกลง Cache) ---
app.post('/api/ask-ai', async (req, res) => {
    const { question } = req.body;
    console.log(`\n🤖 AI Search สำหรับ: "${question}"`);
    if (!question) return res.status(400).json({ error: 'กรุณาส่งคำถามมาด้วย' });

    try {
        const searchQuery = `${question} คืออะไร หน้าที่ การใช้ ประโยชน์ ชื่อทางเคมี`;
        const searchResults = await axios.get(`https://www.googleapis.com/customsearch/v1`, {
            params: { key: process.env.SEARCH_API_KEY, cx: process.env.SEARCH_ENGINE_ID, q: searchQuery, num: 4 }
        });
        
        let googleContext = "ไม่พบข้อมูลจาก Google";
        if (searchResults.data.items && searchResults.data.items.length > 0) {
            googleContext = searchResults.data.items.map(item => `หัวข้อ: ${item.title}\nเนื้อหา: ${item.snippet}`).join('\n\n---\n\n');
        }

        const aiResult = await generateStructuredAnswer(googleContext, question);
        
        const finalResponse = {
            allergy_status: `ไม่พบสารนี้ในฐานข้อมูลหลัก (ข้อมูลนี้เป็นเพียงสิ่งที่เคยค้นหาและบันทึกไว้)`,
            name: aiResult.name,
            aliases: aiResult.aliases,
            func: aiResult.func,
            products: aiResult.products,
            source: 'ผลการค้นหาที่ถูกบันทึกไว้ (Cache)'
        };

        res.json(finalResponse);

    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดบนเซิร์ฟเวอร์" });
    }
});

// --- Endpoint ใหม่! สำหรับดึงข้อมูลสารก่อภูมิแพ้ทั้งหมดจากฐานข้อมูลหลัก ---
app.get('/api/get-all-allergens', ensureDbInitialized, (req, res) => {
    const sql = `SELECT name, keywords FROM allergens ORDER BY name ASC`;
    
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching all allergens:", err.message);
            res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
        } else {
            console.log(`✅ ส่งข้อมูลสารก่อภูมิแพ้ทั้งหมด ${rows.length} รายการ`);
            res.json(rows);
        }
    });
});


app.listen(port, () => {
    console.log(`\n🚀 Backend Server พร้อมทำงาน! รับ Request ที่ http://localhost:${port}`);
});