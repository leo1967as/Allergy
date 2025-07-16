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
let db;

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
    if (!db || !db.isReady) {
        try {
            db = await initializeMainDb();
            db.isReady = true;
        } catch (error) {
            return res.status(500).json({ error: "Database initialization failed.", details: error.message });
        }
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

// --- API Endpoints ---

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

app.post('/api/ask-ai', async (req, res) => {
    const { question } = req.body;
    console.log(`\n🤖 AI Search สำหรับ: "${question}"`);

    try {
        const searchQuery = `${question} คืออะไร หน้าที่ การใช้ ประโยชน์ ชื่อทางเคมี`;
        const searchResults = await axios.get(`https://www.googleapis.com/customsearch/v1`, {
            params: { key: process.env.SEARCH_API_KEY, cx: process.env.SEARCH_ENGINE_ID, q: searchQuery, num: 3 }
        });
        const googleContext = searchResults.data.items?.map(item => `หัวข้อ:${item.title}\nเนื้อหา:${item.snippet}`).join('\n---\n') || "ไม่พบข้อมูล";
        
        const aiResult = await generateStructuredAnswer(googleContext, question);
        
        // แก้ไข: ส่งผลลัพธ์จาก AI กลับไปตรงๆ ให้ Frontend จัดการเรื่อง Cache
        res.json(aiResult);

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

// Export a single handler for Vercel
export default app;