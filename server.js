const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto'); // Built-in Node.js — no install needed
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ─── CONFIG ───
// ⚠️  Replace with your real MongoDB URI. Store in .env in production!
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://deepak:YOUR_PASSWORD@cluster0.abcde.mongodb.net/BishtBros?retryWrites=true&w=majority";

// ─── HELPERS ───
function hashPassword(password) {
    // Simple SHA-256 hash. For production, use bcrypt: `npm install bcrypt`
    return crypto.createHash('sha256').update(password + 'bisht_salt_2026').digest('hex');
}

function generateToken(mobile) {
    return crypto.createHash('sha256').update(mobile + Date.now() + 'secret').digest('hex');
}

// In-memory session store (use Redis for production multi-server setups)
const activeSessions = new Map(); // token -> { mobile, role, name }

// ─── MONGOOSE SCHEMAS ───
const UserSchema = new mongoose.Schema({
    mobile:   { type: String, required: true, unique: true },
    password: { type: String, required: true }, // stored as hash
    name:     { type: String, required: true },
    role:     { type: String, enum: ['admin', 'viewer'], default: 'viewer' }
}, { timestamps: true });

// FIX: amount is Number (was String before — caused calculation bugs)
const RecordSchema = new mongoose.Schema({
    name:   { type: String, required: true },
    amount: { type: Number, required: true, default: 500 },
    date:   { type: String, required: true }, // Format: "March 2026"
    status: { type: String, enum: ['Pending', 'Done'], default: 'Pending' }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Record = mongoose.model('Record', RecordSchema);

// ─── MONGODB CONNECTION ───
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB Connected Successfully!");
        migrateData();
    })
    .catch(err => console.log("❌ Connection Error:", err.message));

// ─── MIGRATE OLD JSON DATA ───
async function migrateData() {
    try {
        if (fs.existsSync('./users.json')) {
            const oldUsers = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
            for (let user of oldUsers) {
                // Hash passwords on migration if not already hashed
                const hashedPwd = user.password.length === 64 ? user.password : hashPassword(user.password);
                await User.findOneAndUpdate(
                    { mobile: user.mobile },
                    { ...user, password: hashedPwd },
                    { upsert: true, new: true }
                );
            }
            console.log("👤 Users migrated to MongoDB");
        }

        if (fs.existsSync('./data.json')) {
            const oldRecords = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
            for (let rec of oldRecords) {
                await Record.findOneAndUpdate(
                    { name: rec.name, date: rec.date },
                    { ...rec, amount: Number(rec.amount) || 500 },
                    { upsert: true, new: true }
                );
            }
            console.log("📊 Ledger records migrated to MongoDB");
        }
    } catch (err) {
        console.log("⚠️  Migration Warning:", err.message);
    }
}

// ─── MIDDLEWARE: Verify Admin ───
async function requireAdmin(req, res, next) {
    const { mobile, token } = req.body;
    
    // Check token-based session
    if (token && activeSessions.has(token)) {
        const session = activeSessions.get(token);
        if (session.mobile === mobile && session.role === 'admin') {
            req.adminUser = session;
            return next();
        }
    }
    
    return res.status(403).json({ error: "Access Denied: Admin only" });
}

// ─── API ROUTES ───

// POST /api/signup
app.post('/api/signup', async (req, res) => {
    try {
        const { mobile, password, name } = req.body;

        if (!mobile || !password || !name) {
            return res.status(400).json({ error: "All fields are required" });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }
        if (!/^\d{10}$/.test(mobile)) {
            return res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
        }

        const exists = await User.findOne({ mobile });
        if (exists) return res.status(400).json({ error: "Mobile number already registered!" });

        const count = await User.countDocuments();
        const role = count === 0 ? 'admin' : 'viewer'; // First user = admin

        const newUser = new User({
            mobile,
            password: hashPassword(password),
            name: name.trim(),
            role
        });
        await newUser.save();

        console.log(`✅ New ${role} registered: ${name} (${mobile})`);
        res.json({ success: true, role, message: `Account created as ${role}` });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Server error: " + e.message });
    }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;

        if (!mobile || !password) {
            return res.status(400).json({ error: "Mobile and password required" });
        }

        // FIX: Compare hashed password instead of plain text
        const user = await User.findOne({ mobile, password: hashPassword(password) });

        if (!user) {
            return res.status(401).json({ error: "Invalid mobile number or password" });
        }

        // Generate session token
        const token = generateToken(mobile);
        activeSessions.set(token, { mobile: user.mobile, role: user.role, name: user.name });

        // Clean up token after 8 hours
        setTimeout(() => activeSessions.delete(token), 8 * 60 * 60 * 1000);

        console.log(`🔑 Login: ${user.name} (${user.role})`);

        res.json({
            success: true,
            user: {
                name: user.name,
                mobile: user.mobile,
                role: user.role,
                token // Client uses this instead of storing password
            }
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Server error" });
    }
});

// GET /api/records — Public (all logged-in users can view)
app.get('/api/records', async (req, res) => {
    try {
        const records = await Record.find().select('-__v').lean();
        res.json(records);
    } catch (e) {
        res.status(500).json({ error: "Could not fetch records" });
    }
});

// POST /api/records — Admin only
app.post('/api/records', requireAdmin, async (req, res) => {
    try {
        const { name, amount, date, status } = req.body;

        if (!name || !date) {
            return res.status(400).json({ error: "Name and date are required" });
        }

        const numAmount = Number(amount);
        if (isNaN(numAmount) || numAmount < 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        await Record.findOneAndUpdate(
            { name, date },
            { amount: numAmount, status: status || 'Pending' },
            { upsert: true, new: true }
        );

        console.log(`📝 Record updated: ${name} | ${date} | ₹${numAmount} | ${status}`);
        res.json({ success: true });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Save failed: " + e.message });
    }
});

// POST /api/logout (optional but clean)
app.post('/api/logout', (req, res) => {
    const { token } = req.body;
    if (token) activeSessions.delete(token);
    res.json({ success: true });
});

// ─── START SERVER ───
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Bisht Bros Server Live → http://localhost:${PORT}`);
});

